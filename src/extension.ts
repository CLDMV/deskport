/**
 * DeskPort — VSCode extension.
 *
 * Declared `extensionKind: ["ui"]`, so VSCode runs it in the LOCAL extension
 * host even when the workspace is opened over Remote-SSH. That is the whole
 * trick: the extension executes on the machine with the display, so it can
 * spawn real local GUI processes (Electron, etc.) while being driven from the
 * remote VSCode window.
 *
 * Syncing uses VSCode's own filesystem bridge (`vscode.workspace.fs`) — it
 * reuses the connection Remote-SSH already holds. No `ssh` or `rsync` is
 * needed on the local machine, so it works on stock Windows / macOS / Linux.
 * The mirror is kept live by a `FileSystemWatcher`: each remote edit copies a
 * single file, so hot-reload is event-driven.
 *
 * Targets come from one or more `.deskport/config.json` files: one at the
 * workspace root and/or one per package in a monorepo. Each config owns the
 * folder its `.deskport/` sits in, and a target's `cwd` is relative to that
 * folder. A target can be started from the status-bar menu, or from the REMOTE
 * host by writing a trigger file (resources/trigger.mjs) — giving a "remote
 * command -> local launch" flow.
 *
 * Local requirements: only what a target command itself needs (node, pnpm, …).
 */

import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, rm, stat as statLocal, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Directory segments skipped by default during sync. Always applied; the
 * config's own `excludes` list is added to these rather than replacing them,
 * so a user can't accidentally lose `node_modules` etc. by listing one extra
 * entry.
 */
const DEFAULT_EXCLUDES = [
	"node_modules",
	".pnpm-store",
	".pnpm",
	".git",
	"out",
	"dist",
	"release",
	"__tests__",
	"docs",
	"examples",
	"screenshots"
];
/**
 * Filename globs skipped by default during sync (docs / changelogs / test
 * scaffolding / lockfiles — none of which the runtime needs). Matched against
 * each file's basename, not its full path. Like {@link DEFAULT_EXCLUDES},
 * always applied — the config's `excludeFiles` is additive.
 *
 * A target's `includeFiles` overrides this — useful when an app actually
 * needs e.g. a `README.md` at runtime.
 */
const DEFAULT_FILE_EXCLUDES = [
	"*.md",
	"*.markdown",
	"*.txt",
	"*.log",
	"*.test.*",
	"*.spec.*",
	"*.lock",
	"LICENSE",
	"LICENSE.*",
	"CHANGELOG",
	"CHANGELOG.*"
];
const CONFIG_REL = ".deskport/config.json";
const TRIGGER_MJS_REL = ".deskport/trigger.mjs";
const GITIGNORE_REL = ".gitignore";
/** The file whose presence marks a pnpm workspace root during the walk-up. */
const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";
/**
 * Root-level files a pnpm workspace install needs, mirrored alongside the
 * target package and its dependency closure (only the ones that actually
 * exist remotely are copied). The lockfile and workspace manifest let pnpm
 * resolve `workspace:*` links; `.npmrc` / `.pnpmfile.cjs` carry install config.
 */
const PNPM_ROOT_FILES = [PNPM_WORKSPACE_FILE, "pnpm-lock.yaml", "package.json", ".npmrc", ".pnpmfile.cjs"];
/** Default for `deskport.workspaceMaxHeight` when neither config nor setting sets it. */
const DEFAULT_WORKSPACE_MAX_HEIGHT = 5;
/** Skip a re-copy when local size matches and mtime is within this window. */
const MTIME_TOLERANCE_MS = 2000;
/** Max characters of a process's output kept for error reporting. */
const OUTPUT_TAIL_LIMIT = 4000;

interface TargetConfig {
	/** Shell command to run (from the synced repo). */
	command: string;
	/** Display name; defaults to the target key. */
	label?: string;
	/** Directory to run from, relative to this config's folder; defaults to ".". */
	cwd?: string;
	/** Card icon: a `data:` URI, an image path relative to this folder, or raw base64. */
	icon?: string;
}

interface LauncherConfig {
	/** Command run once, in this config's folder, before its first target launches. */
	install?: string;
	/**
	 * Directory segments to skip when mirroring this scope (additive — added to
	 * the always-on {@link DEFAULT_EXCLUDES}). Matched against single path
	 * segments; supports `*` wildcards.
	 */
	excludes?: string[];
	/**
	 * Filename globs to skip when mirroring this scope (additive — added to
	 * the always-on {@link DEFAULT_FILE_EXCLUDES}). A glob without `/` is
	 * matched against the basename; one containing `/` is matched against the
	 * scope-relative path. Supports `*`, `**`, and `?`.
	 */
	excludeFiles?: string[];
	/**
	 * Globs that force a file to be included even when {@link excludeFiles} or
	 * `.gitignore` would otherwise skip it (segment-level `excludes` still
	 * apply — to bring back a whole directory, list it explicitly here as a
	 * path, e.g. `"docs/**"`).
	 */
	includeFiles?: string[];
	/**
	 * Extra paths to mirror alongside this config's folder, resolved relative
	 * to this config's folder (`..` allowed; must stay inside the workspace).
	 * Each extra lands at its natural remote-absolute mirror path so a target
	 * can keep its real relative imports, e.g. `["../shared-lib"]` lets the
	 * package's source still `import "../shared-lib"`.
	 */
	include?: string[];
	/**
	 * Whether to honor a `.gitignore` at this scope's root when picking files
	 * to mirror. Defaults to `true`. Negation patterns (`!keep.me`) are not
	 * supported yet — use `includeFiles` for force-includes.
	 */
	respectGitignore?: boolean;
	/**
	 * How many directory levels to walk **up** from this config's folder
	 * looking for a `pnpm-workspace.yaml` before launching a target. When one
	 * is found within the cap, that directory becomes the workspace root: the
	 * cold sync mirrors its manifests + this package + the target's
	 * `workspace:*` dependency closure, and `install` runs from there so pnpm
	 * linkage resolves. When none is found, only this folder is synced.
	 *
	 * The walk only runs when **both** gates are satisfied: this package's
	 * `install` command is pnpm-prefixed (`pnpm …`) **and** its own
	 * `package.json` declares at least one `workspace:*` dep. A package whose
	 * install is `npm install`, or that has no `workspace:*` deps, stays
	 * self-contained even when a `pnpm-workspace.yaml` sits above it.
	 *
	 * Overrides the `deskport.workspaceMaxHeight` setting. `0` disables the walk.
	 */
	workspaceMaxHeight?: number;
	targets: Record<string, TargetConfig>;
}

/** One discovered `.deskport/config.json` and the package folder it owns. */
interface DiscoveredConfig {
	/** Workspace-relative folder owning this config; "" for the workspace root. */
	packageRel: string;
	config: LauncherConfig;
}

/** A single target flattened out of its owning config, with a unique id. */
interface ResolvedTarget {
	/** Unique across the workspace: `<packageRel>/<key>`, or `<key>` at the root. */
	id: string;
	/** Target key within its own config. */
	key: string;
	/** Folder owning the config ("" for the workspace root). */
	packageRel: string;
	pkg: DiscoveredConfig;
	target: TargetConfig;
}

interface Workspace {
	folder: vscode.WorkspaceFolder;
	/** SSH host, or null when the workspace is already local. */
	remote: string | null;
	/** Absolute repo path on the host. */
	repoPath: string;
}

/**
 * A target's terminal — a pseudoterminal DeskPort feeds from a process it
 * spawns itself. The spawn happens in the (local) extension host, so the
 * target runs on THIS machine even when the workspace is remote.
 */
interface TargetTerminal {
	id: string;
	terminal: vscode.Terminal;
	/** Writes text to the terminal UI. */
	writer: vscode.EventEmitter<string>;
	/** The process currently running in it, if any. */
	child?: ChildProcess;
	/** A launch queued until the pseudoterminal's open() fires. */
	pending?: { rt: ResolvedTarget; runCwd: string };
	/** How the most recent run ended — drives the sidebar status. */
	exit?: { code: number | null; signal: NodeJS.Signals | null };
	/**
	 * Set when DeskPort itself initiates a stop (stop button, Ctrl+C, stop-all)
	 * and cleared in the child's `exit` handler. Lets that handler distinguish
	 * a user-driven shutdown from a real crash on Windows, where `taskkill /F`
	 * exits the shell with `code: 1, signal: null` — indistinguishable from a
	 * failure without this flag.
	 */
	stopping?: boolean;
}

let extensionUri: vscode.Uri;
/** This extension's version, read from its manifest at activation. */
let extensionVersion = "";
let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
let targetsProvider: TargetsViewProvider;
/** The default card icon (resources/panel-icon.svg), loaded at activation. */
let rocketSvg = "";
let workspace: Workspace | undefined;
let configs: DiscoveredConfig[] = [];
let configErrors: string[] = [];
/**
 * True while a config-discovery scan is running. Pushed to the sidebar so the
 * webview can render a "Scanning…" state and to the footer so the indicator
 * stays visible even after the first config shows up.
 */
let scanning = false;
/** The current in-flight scan, so concurrent {@link loadConfigs} calls share one pass. */
let scanInFlight: Promise<void> | undefined;
/** Set while a scan is running if another caller asks for a re-scan; triggers a follow-up pass. */
let rescanNeeded = false;
let busyText: string | undefined;
/**
 * Target id currently in its sync/install/spawn handoff, so the sidebar can
 * show a per-target "launching…" state in the gap between the click and the
 * actual spawn. Cleared from {@link startProcess} once the child is set, or
 * from {@link launchTarget} when the run is cancelled or fails before spawn.
 * Only one launch runs at a time (the {@link busyText} guard enforces this),
 * so a single id is enough.
 */
let launchingId: string | undefined;
let lastTriggerNonce: number | undefined;
let watchers: vscode.Disposable[] = [];
/** Live FS watchers — one (or, for a files-only scope, one per file) per active scope. */
let syncWatchers: vscode.FileSystemWatcher[] = [];
/**
 * One scope's effective filter — the compiled `.gitignore` rules plus the
 * file-level globs the scope was synced with. Kept around after the cold sync
 * so the live FS watcher can apply the same filtering to incremental changes.
 */
interface ScopeFilter {
	ignoreRules: IgnoreRule[];
	/** {@link DEFAULT_FILE_EXCLUDES} merged with the config's `excludeFiles`. */
	excludeFiles: string[];
	/** The config's `includeFiles`. */
	includeFiles: string[];
}

/**
 * Every scope mirrored by a currently-running launch, keyed by {@link jobKey}.
 * A scope's {@link SyncJob} carries its remote root, local mirror dir, and the
 * filters it was scanned with — the live FS watcher rebuilds one watcher per
 * job from this map so incremental updates obey the same rules as the cold
 * sync, and concurrent targets contribute the union of their scopes.
 *
 * Each launch re-runs the cold sync for its scopes (the per-file stat-then-
 * skip optimization makes a no-op revalidation cheap), so missed
 * `FileSystemWatcher` events — e.g. atomic renames from `sed -i` — are caught
 * on the next launch rather than leaving the mirror permanently stale.
 */
const activeJobs = new Map<string, SyncJob>();
/** packageRel values whose `install` command has run this session. */
const installedPackages = new Set<string>();
/**
 * Resolved SSH hostnames keyed by VSCode's alias (the `ssh-remote+<alias>`
 * authority). Computed once per session via `ssh -G <alias>` so two different
 * `~/.ssh/config` aliases pointing at the same machine produce one mirror
 * directory, not two. Falls back to the alias itself if `ssh -G` is
 * unreachable or didn't return a `hostname` line.
 */
const resolvedHosts = new Map<string, string>();
/** Open terminals, keyed by target id — one per target, reused across launches. */
const terminals = new Map<string, TargetTerminal>();

/** The run state of a target, shown in the sidebar. */
type TargetStatus = "idle" | "launching" | "running" | "exited" | "failed" | "stopped";

/** Derive a target's status from its terminal and most recent exit. */
function targetStatus(id: string): TargetStatus {
	if (launchingId === id) return "launching";
	const tt = terminals.get(id);
	if (!tt) return "idle";
	if (tt.child) return "running";
	if (!tt.exit) return "idle";
	if (tt.exit.code === 0) return "exited";
	if (tt.exit.signal) return "stopped";
	return "failed";
}

/**
 * The active sub-phase of a "launching" target, derived from {@link busyText}.
 * Lets the sidebar button read "Syncing…" / "Installing…" instead of a static
 * "Launching…" across the whole pre-spawn handoff. The busyText values are the
 * ones {@link launchTarget} passes to {@link setBusy} during the launch.
 */
function launchPhase(): "launching" | "syncing" | "installing" {
	if (busyText === "syncing") return "syncing";
	if (busyText === "installing dependencies") return "installing";
	return "launching";
}

/** A target's status as text — `failed` carries its exit code; launching carries its phase. */
function statusLabel(id: string): string {
	const status = targetStatus(id);
	if (status === "launching") return `${launchPhase()}…`;
	if (status === "failed") {
		const code = terminals.get(id)?.exit?.code;
		return code != null ? `failed (exit ${code})` : "failed";
	}
	return status;
}

/** What the sidebar action button reads: "Run" / "Stop" / phase-specific "…ing…" while launching. */
function buttonLabel(status: TargetStatus): string {
	if (status === "launching") {
		const phase = launchPhase();
		return `${phase.charAt(0).toUpperCase()}${phase.slice(1)}…`;
	}
	if (status === "running") return "Stop";
	return "Run";
}

/** One target rendered as a card in the sidebar webview. */
interface CardData {
	id: string;
	label: string;
	command: string;
	folder: string;
	status: TargetStatus;
	statusLabel: string;
	/** Action-button text: "Run" / "Stop" / phase-specific "…ing…" while launching. */
	buttonLabel: string;
	/** A resolved `data:` URI for a custom icon, or undefined for the default. */
	icon?: string;
}

const IMAGE_EXT = /\.(png|svg|jpe?g|gif|ico|webp)$/i;
/** Resolved custom icons keyed by target id; cleared when configs reload. */
const iconCache = new Map<string, string | undefined>();

function imageMime(path: string): string {
	if (/\.svg$/i.test(path)) return "image/svg+xml";
	if (/\.jpe?g$/i.test(path)) return "image/jpeg";
	if (/\.gif$/i.test(path)) return "image/gif";
	if (/\.ico$/i.test(path)) return "image/x-icon";
	if (/\.webp$/i.test(path)) return "image/webp";
	return "image/png";
}

/**
 * Resolve a target's optional `icon` to a `data:` URI. The icon may be a
 * `data:` URI as-is, a path (relative to the config's folder) to an image
 * file, or raw base64 image data. Undefined falls back to the default rocket.
 */
async function resolveIcon(rt: ResolvedTarget): Promise<string | undefined> {
	if (iconCache.has(rt.id)) return iconCache.get(rt.id);
	let resolved: string | undefined;
	const spec = rt.target.icon?.trim();
	if (spec?.startsWith("data:")) {
		resolved = spec;
	} else if (spec && IMAGE_EXT.test(spec) && workspace) {
		try {
			const rel = joinRel(rt.packageRel, spec);
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspace.folder.uri, rel));
			resolved = `data:${imageMime(spec)};base64,${Buffer.from(bytes).toString("base64")}`;
		} catch {
			resolved = undefined;
		}
	} else if (spec) {
		// Anything else is treated as raw base64 image data.
		resolved = `data:image/png;base64,${spec.replace(/\s+/g, "")}`;
	}
	iconCache.set(rt.id, resolved);
	return resolved;
}

/** Build the sidebar's state — one card per target, with resolved icons. */
async function buildViewState(): Promise<{ cards: CardData[]; errors: string[]; scanning: boolean }> {
	const cards: CardData[] = [];
	for (const rt of allTargets()) {
		const status = targetStatus(rt.id);
		cards.push({
			id: rt.id,
			label: rt.target.label ?? rt.key,
			command: rt.target.command,
			folder: rt.packageRel || "workspace root",
			status,
			statusLabel: statusLabel(rt.id),
			buttonLabel: buttonLabel(status),
			icon: await resolveIcon(rt),
		});
	}
	return { cards, errors: configErrors, scanning };
}

/** Open the `.deskport/config.json` that defines a target. */
function openTargetConfig(id: string): void {
	const rt = findTarget(id);
	if (!rt || !workspace) return;
	const configRel = rt.packageRel ? `${rt.packageRel}/${CONFIG_REL}` : CONFIG_REL;
	void vscode.commands.executeCommand("vscode.open", vscode.Uri.joinPath(workspace.folder.uri, configRel));
}

/** Reveal a target's package folder in the Explorer. */
function revealTargetFolder(id: string): void {
	const rt = findTarget(id);
	if (!rt || !workspace) return;
	const uri = rt.packageRel ? vscode.Uri.joinPath(workspace.folder.uri, rt.packageRel) : workspace.folder.uri;
	void vscode.commands.executeCommand("revealInExplorer", uri);
}

/** A random nonce for the webview's Content-Security-Policy. */
function nonce(): string {
	return Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/** The HTML for the targets webview; cards are rendered client-side from state. */
function viewHtml(webview: vscode.Webview): string {
	const n = nonce();
	const csp = `default-src 'none'; img-src data: ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${n}';`;
	return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
body { margin: 0; padding: 0; color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
.card { display: flex; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18)); }
.card:hover { background: var(--vscode-list-hoverBackground); }
.icon { flex: none; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; color: var(--vscode-foreground); }
.icon img { max-width: 36px; max-height: 36px; }
.icon svg { width: 28px; height: 28px; }
.body { flex: 1; min-width: 0; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmd, .meta { color: var(--vscode-descriptionForeground); font-size: .92em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmd { margin: 2px 0; }
.link { cursor: pointer; }
.link:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: middle; background: var(--vscode-descriptionForeground); }
.s-running, .s-exited { background: var(--vscode-charts-green, #89d185); }
.s-failed { background: var(--vscode-errorForeground, #f14c4c); }
.s-stopped { background: var(--vscode-charts-yellow, #cca700); }
.s-launching { background: var(--vscode-progressBar-background, #0e639c); animation: dp-pulse 1.2s ease-in-out infinite; }
@keyframes dp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.st-failed { color: var(--vscode-errorForeground, #f14c4c); }
.actions { flex: none; }
button { font: inherit; cursor: pointer; border: none; border-radius: 2px; padding: 4px 11px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { cursor: default; opacity: .75; }
button.stop { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.stop:hover { background: var(--vscode-button-secondaryHoverBackground); }
.empty { padding: 16px 12px; color: var(--vscode-descriptionForeground); }
.empty button { margin-top: 10px; }
.empty.scanning { color: var(--vscode-progressBar-background, #0e639c); animation: dp-pulse 1.2s ease-in-out infinite; }
.err { padding: 8px 12px; color: var(--vscode-errorForeground); font-size: .92em; }
.foot { padding: 6px 12px; color: var(--vscode-descriptionForeground); font-size: .85em; border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.18)); }
.foot .scan { color: var(--vscode-progressBar-background, #0e639c); animation: dp-pulse 1.2s ease-in-out infinite; }
</style></head><body>
<div id="root"></div>
<div id="foot" class="foot">DeskPort${extensionVersion ? " v" + extensionVersion : ""}</div>
<script nonce="${n}">
const api = acquireVsCodeApi();
const ROCKET = ${JSON.stringify(rocketSvg)};
const VERSION = ${JSON.stringify(extensionVersion)};
const root = document.getElementById("root");
const foot = document.getElementById("foot");
function setFoot(scanning) {
	const base = "DeskPort" + (VERSION ? " v" + VERSION : "");
	foot.textContent = "";
	foot.appendChild(document.createTextNode(base));
	if (scanning) {
		foot.appendChild(document.createTextNode(" · "));
		const s = document.createElement("span");
		s.className = "scan";
		s.textContent = "scanning…";
		foot.appendChild(s);
	}
}
function send(type, id) { api.postMessage({ type: type, id: id }); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function card(c) {
	const wrap = el("div", "card");
	const icon = el("div", "icon");
	if (c.icon) { const img = el("img"); img.src = c.icon; icon.appendChild(img); }
	else { icon.innerHTML = ROCKET; }
	wrap.appendChild(icon);
	const body = el("div", "body");
	body.appendChild(el("div", "name", c.label));
	const cmd = el("div", "cmd link", c.command);
	cmd.title = "Open the .deskport/config.json";
	cmd.onclick = function () { send("openConfig", c.id); };
	body.appendChild(cmd);
	const meta = el("div", "meta");
	const folder = el("span", "link", c.folder);
	folder.title = "Reveal the folder";
	folder.onclick = function () { send("revealFolder", c.id); };
	meta.appendChild(folder);
	meta.appendChild(document.createTextNode("  ·  "));
	const status = el("span", "link" + (c.status === "failed" ? " st-failed" : ""));
	status.title = "Open the terminal";
	status.onclick = function () { send("openTerminal", c.id); };
	status.appendChild(el("span", "dot s-" + c.status));
	status.appendChild(document.createTextNode(c.statusLabel));
	meta.appendChild(status);
	body.appendChild(meta);
	wrap.appendChild(body);
	const actions = el("div", "actions");
	const launching = c.status === "launching";
	const running = c.status === "running";
	const btn = el("button", running ? "stop" : "", c.buttonLabel);
	if (launching) btn.disabled = true;
	btn.onclick = function () { if (!launching) send(running ? "stop" : "launch", c.id); };
	actions.appendChild(btn);
	wrap.appendChild(actions);
	return wrap;
}
function render(state) {
	root.textContent = "";
	setFoot(!!state.scanning);
	for (const e of state.errors || []) root.appendChild(el("div", "err", e));
	if (!state.cards || !state.cards.length) {
		if (state.scanning) {
			root.appendChild(el("div", "empty scanning", "Scanning workspace for .deskport/config.json…"));
		} else {
			const d = el("div", "empty", "No DeskPort targets found in this workspace.");
			const b = el("button", "", "Initialize Project");
			b.onclick = function () { send("init"); };
			d.appendChild(document.createElement("br"));
			d.appendChild(b);
			root.appendChild(d);
		}
		return;
	}
	for (const c of state.cards) root.appendChild(card(c));
}
window.addEventListener("message", function (e) { if (e.data && e.data.type === "state") render(e.data); });
send("ready");
</script></body></html>`;
}

/** Backs the "Targets" sidebar — a webview of target cards. */
class TargetsViewProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = viewHtml(view.webview);
		view.webview.onDidReceiveMessage((msg: { type?: string; id?: string }) => {
			const id = msg.id ?? "";
			switch (msg.type) {
				case "launch":
					void launchTarget(id);
					break;
				case "stop":
					stopTarget(id);
					break;
				case "openTerminal":
					openTerminal(id);
					break;
				case "openConfig":
					openTargetConfig(id);
					break;
				case "revealFolder":
					revealTargetFolder(id);
					break;
				case "init":
					void initProject();
					break;
				case "ready":
					void this.refresh();
					break;
			}
		});
		view.onDidChangeVisibility(() => {
			if (view.visible) void this.refresh();
		});
	}

	/** Push the current target list to the webview, if it is resolved. */
	async refresh(): Promise<void> {
		if (!this.view) return;
		const state = await buildViewState();
		void this.view.webview.postMessage({ type: "state", ...state });
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	extensionUri = context.extensionUri;
	extensionVersion = (context.extension.packageJSON as { version?: string }).version ?? "";
	output = vscode.window.createOutputChannel("DeskPort");
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusItem.command = "deskport.menu";
	targetsProvider = new TargetsViewProvider();

	// Show the status bar item immediately, from the synchronous part of
	// activation — so a slow or failing config scan can never leave DeskPort
	// invisible. Config discovery happens afterwards and refreshes the item.
	workspace = resolveWorkspace();
	updateStatus();
	statusItem.show();
	output.appendLine("[deskport] extension activated");

	context.subscriptions.push(
		output,
		statusItem,
		vscode.commands.registerCommand("deskport.menu", showMenu),
		vscode.commands.registerCommand("deskport.refresh", refresh),
		vscode.commands.registerCommand("deskport.init", initProject),
		vscode.commands.registerCommand("deskport.launch", (id: string) => launchTarget(id)),
		vscode.commands.registerCommand("deskport.stop", (id: string) => stopTarget(id)),
		vscode.commands.registerCommand("deskport.openTerminal", (id: string) => openTerminal(id)),
		vscode.window.registerWebviewViewProvider("deskport.targets", targetsProvider),
		vscode.window.onDidCloseTerminal(forgetClosedTerminal),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			workspace = resolveWorkspace();
			registerWatchers();
			updateStatus();
			void loadConfigs();
		}),
		{ dispose: () => watchers.forEach((w) => w.dispose()) },
		{ dispose: stopSyncWatchers }
	);
	registerWatchers();

	try {
		rocketSvg = Buffer.from(
			await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, "resources", "panel-icon.svg"))
		).toString("utf8");
	} catch {
		/* the default card icon is blank if the asset cannot be read */
	}

	// Kick off the initial config scan in the background. Awaiting here would
	// leave the extension stuck in activation until the scan returned — slow on
	// large workspaces opened over Remote-SSH. `loadConfigs` posts its own
	// `scanning…` state to the sidebar, and errors are logged inside it.
	void loadConfigs();
}

export function deactivate(): void {
	stopAll();
}

function resolveWorkspace(): Workspace | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return undefined;
	const uri = folder.uri;

	if (uri.scheme === "file") {
		return { folder, remote: null, repoPath: uri.fsPath };
	}
	if (uri.scheme === "vscode-remote") {
		const authority = uri.authority;
		const plus = authority.indexOf("+");
		if (authority.startsWith("ssh-remote") && plus >= 0) {
			return { folder, remote: decodeHost(authority.slice(plus + 1)), repoPath: uri.path };
		}
	}
	return undefined;
}

/**
 * VSCode keeps a plain SSH-config host label as-is, but hex-encodes hosts that
 * carry settings or special characters. Decode the hex form when we see it.
 */
function decodeHost(raw: string): string {
	if (raw.length >= 2 && raw.length % 2 === 0 && /^[0-9a-f]+$/i.test(raw)) {
		try {
			return Buffer.from(raw, "hex").toString("utf8");
		} catch {
			return raw;
		}
	}
	return raw;
}

/**
 * Discover every `.deskport/config.json` in the workspace via VSCode's search
 * service (ripgrep on the remote side under Remote-SSH). This is orders of
 * magnitude faster than the previous recursive `workspace.fs.readDirectory`
 * walk, which paid one network round-trip per directory and could take minutes
 * on a large monorepo opened over Remote-SSH.
 *
 * Concurrent callers (activation, the FS watcher, the user-facing Refresh
 * command, the workspace-folders listener) share one in-flight scan via
 * {@link scanInFlight}. If anyone asks for a re-scan while one is running,
 * {@link rescanNeeded} is set and another pass runs immediately after — so
 * changes that landed during the current scan still get picked up.
 */
async function loadConfigs(): Promise<void> {
	if (scanInFlight) {
		rescanNeeded = true;
		return scanInFlight;
	}
	scanInFlight = (async () => {
		do {
			rescanNeeded = false;
			await runScanPass();
		} while (rescanNeeded);
	})();
	try {
		await scanInFlight;
	} finally {
		scanInFlight = undefined;
	}
}

/** One pass of the scan — drives the `scanning` indicator and populates {@link configs}. */
async function runScanPass(): Promise<void> {
	configs = [];
	configErrors = [];
	iconCache.clear();
	if (!workspace) return;

	scanning = true;
	updateStatus();
	output.appendLine("[deskport] scanning workspace for .deskport/config.json…");
	const started = Date.now();
	try {
		// Build a brace-expansion exclude glob from DEFAULT_EXCLUDES so we
		// don't waste search time inside `node_modules`, `.git`, build dirs,
		// etc. Passing our own exclude overrides VSCode's `search.exclude`
		// default — which is fine: a user-configured search.exclude shouldn't
		// silently hide their DeskPort configs.
		const exclude = `{${DEFAULT_EXCLUDES.map((d) => `**/${d}/**`).join(",")}}`;
		const uris = await vscode.workspace.findFiles(
			new vscode.RelativePattern(workspace.folder, "**/.deskport/config.json"),
			exclude
		);
		for (const uri of uris) {
			const rel = vscode.workspace.asRelativePath(uri, false);
			// e.g. "packages/foo/.deskport/config.json" → packageRel "packages/foo"
			//        ".deskport/config.json"            → packageRel ""
			const packageRel = rel.split("/").slice(0, -2).join("/");
			await readConfigFile(uri, packageRel);
		}
		// Root config first, then nested ones in path order — a stable menu order.
		configs.sort((a, b) => a.packageRel.localeCompare(b.packageRel));
		output.appendLine(
			`[deskport] scan complete in ${Date.now() - started}ms — ${configs.length} config(s)`
		);
	} catch (err) {
		const msg = (err as Error).message;
		output.appendLine(`[deskport] config scan failed: ${msg}`);
		configErrors.push(`Scan failed: ${msg}`);
	} finally {
		scanning = false;
		updateStatus();
	}
}

/** Parse one `.deskport/config.json`, recording it or its error. */
async function readConfigFile(uri: vscode.Uri, packageRel: string): Promise<void> {
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(uri);
	} catch {
		return; // a `.deskport/` folder without a config.json — not an error
	}
	const label = `${packageRel ? packageRel + "/" : ""}.deskport/config.json`;
	try {
		const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as LauncherConfig;
		if (!parsed.targets || typeof parsed.targets !== "object" || Object.keys(parsed.targets).length === 0) {
			configErrors.push(`${label} defines no "targets".`);
			return;
		}
		configs.push({ packageRel, config: parsed });
	} catch (err) {
		configErrors.push(`${label} is not valid JSON: ${(err as Error).message}`);
	}
}

/** The workspace-root config, if one exists — it owns excludes. */
function rootConfig(): LauncherConfig | undefined {
	return configs.find((c) => c.packageRel === "")?.config;
}

/** Unique target id; the package folder disambiguates colliding target keys. */
function targetId(packageRel: string, key: string): string {
	return packageRel ? `${packageRel}/${key}` : key;
}

function allTargets(): ResolvedTarget[] {
	const out: ResolvedTarget[] = [];
	for (const pkg of configs) {
		for (const [key, target] of Object.entries(pkg.config.targets)) {
			out.push({ id: targetId(pkg.packageRel, key), key, packageRel: pkg.packageRel, pkg, target });
		}
	}
	return out;
}

function findTarget(id: string): ResolvedTarget | undefined {
	return allTargets().find((t) => t.id === id);
}

/** Join two workspace-relative paths, dropping empty and "." segments. */
function joinRel(a: string, b: string): string {
	return [...a.split("/"), ...b.split("/")].filter((s) => s && s !== ".").join("/");
}

/**
 * Whether a list of URIs touches any `.deskport` path — used to decide if a
 * VSCode file-operation event (create/rename/delete from the Explorer or any
 * other extension) should trigger a config re-scan. Matches both the
 * `.deskport` directory itself and anything beneath it, so renaming a folder
 * INTO `.deskport` (or out of it) is caught too.
 */
function touchesDeskport(uris: readonly vscode.Uri[]): boolean {
	return uris.some((u) => /(^|\/)\.deskport(\/|$)/.test(u.path));
}

function registerWatchers(): void {
	for (const w of watchers) w.dispose();
	watchers = [];
	if (!workspace) return;

	const triggerWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(workspace.folder, "**/.deskport/trigger.json")
	);
	triggerWatcher.onDidChange(handleTrigger);
	triggerWatcher.onDidCreate(handleTrigger);

	const configWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(workspace.folder, "**/.deskport/config.json")
	);
	const reload = async (): Promise<void> => {
		await loadConfigs();
		updateStatus();
	};
	configWatcher.onDidChange(reload);
	configWatcher.onDidCreate(reload);
	configWatcher.onDidDelete(reload);

	// File-operation events complement the FS watcher: the FS watcher only
	// notifies about `config.json` itself, so renaming/deleting a `.deskport`
	// directory (or creating one via the Explorer's "New Folder") would
	// otherwise need a manual refresh. These fire for VSCode-initiated ops
	// from the Explorer or any extension's `workspace.fs` calls.
	const onCreate = vscode.workspace.onDidCreateFiles((e) => {
		if (touchesDeskport(e.files)) void reload();
	});
	const onDelete = vscode.workspace.onDidDeleteFiles((e) => {
		if (touchesDeskport(e.files)) void reload();
	});
	const onRename = vscode.workspace.onDidRenameFiles((e) => {
		const all = e.files.flatMap((p) => [p.oldUri, p.newUri]);
		if (touchesDeskport(all)) void reload();
	});

	watchers = [triggerWatcher, configWatcher, onCreate, onDelete, onRename];
}

async function handleTrigger(uri: vscode.Uri): Promise<void> {
	let data: { target?: string; nonce?: number };
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		data = JSON.parse(Buffer.from(bytes).toString("utf8")) as { target?: string; nonce?: number };
	} catch (err) {
		output.appendLine(`[deskport] ignored unreadable trigger: ${(err as Error).message}`);
		return;
	}
	if (!data.target) return;
	if (typeof data.nonce === "number" && data.nonce === lastTriggerNonce) return;
	lastTriggerNonce = typeof data.nonce === "number" ? data.nonce : undefined;

	// The trigger file lives in its package's `.deskport/`, so the target name
	// resolves within that same package.
	const packageRel = vscode.workspace.asRelativePath(uri, false).split("/").slice(0, -2).join("/");
	const id = targetId(packageRel, data.target);
	output.appendLine(`[deskport] remote trigger -> ${JSON.stringify(id)}`);
	await launchTarget(id);
}

/**
 * Base directory where remote workspaces are mirrored on the local machine.
 *
 * Read fresh from the `deskport.clonePath` setting on every call, so a
 * change in VSCode's settings UI takes effect on the next launch with no reload.
 * The workspace folder URI is passed so VSCode resolves the value with the
 * normal precedence — Workspace settings override User/global settings.
 */
function cloneRoot(): string {
	const setting = vscode.workspace
		.getConfiguration("deskport", workspace?.folder.uri)
		.get<string>("clonePath", "")
		.trim();
	if (!setting) return join(homedir(), ".deskport-mirrors");
	if (setting === "~") return homedir();
	if (setting.startsWith("~/") || setting.startsWith("~\\")) return join(homedir(), setting.slice(2));
	return setting;
}

/** Replace characters unsafe in a local path segment (Windows-strict). */
function sanitizeSegment(s: string): string {
	const cleaned = s.replace(/[<>:"\\|?*\x00-\x1f]/g, "_");
	return cleaned || "_";
}

/**
 * Resolve VSCode's SSH alias to the actual hostname (and port when non-default)
 * by shelling out to `ssh -G <alias>` on the local machine. This is the same
 * resolution SSH itself does, so it honors `~/.ssh/config` files, `Include`
 * directives, `Match` rules, and any other config feature the user has.
 *
 * The result is cached for the session — `scopeMirrorDir` then reads it
 * synchronously. On any failure (no `ssh` on PATH, exit != 0, no `hostname`
 * line in the output) we cache the alias itself as the fallback, so the worst
 * case is "no cross-alias dedup" rather than a broken mirror path.
 */
function resolveSshHost(alias: string): Promise<string> {
	const cached = resolvedHosts.get(alias);
	if (cached !== undefined) return Promise.resolve(cached);
	return new Promise((resolve) => {
		let stdout = "";
		const child = spawn("ssh", ["-G", alias], { env: childEnv() });
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		const finish = (resolved: string): void => {
			const safe = sanitizeSegment(resolved);
			resolvedHosts.set(alias, safe);
			if (resolved !== alias) output.appendLine(`[deskport] ssh ${alias} → ${resolved}`);
			resolve(safe);
		};
		child.on("error", () => finish(alias));
		child.on("exit", (code) => {
			if (code !== 0) return finish(alias);
			let hostname = "";
			let port = "";
			for (const line of stdout.split(/\r?\n/)) {
				const m = line.trim().match(/^(\S+)\s+(.+)$/);
				if (!m) continue;
				const key = m[1]!.toLowerCase();
				const val = m[2]!;
				if (key === "hostname" && !hostname) hostname = val;
				else if (key === "port" && !port) port = val;
			}
			if (!hostname) return finish(alias);
			finish(port && port !== "22" ? `${hostname}_${port}` : hostname);
		});
	});
}

/**
 * The local folder where one scope of the remote workspace is mirrored.
 *
 * The path encodes the **resolved SSH hostname** (via {@link resolveSshHost})
 * and the **absolute remote path** of the scope's folder, so the same remote
 * folder always maps to the same local path — regardless of which parent
 * directory the user happened to open as the workspace, *and* regardless of
 * which `~/.ssh/config` alias they reached the host through. Two aliases
 * pointing at the same machine share one mirror.
 *
 * `scopeRel` is workspace-relative; `""` means the workspace folder itself.
 *
 * Callers must `await resolveSshHost(ws.remote)` once per session before the
 * first call so the host cache is populated; until then this falls back to
 * the alias itself so the function stays synchronous (the FS watcher needs
 * synchronous lookups for routing each file event).
 */
function scopeMirrorDir(ws: Workspace, scopeRel: string): string {
	const trimmedRepo = ws.repoPath.replace(/\/+$/, "");
	return mirrorDirForAbs(ws, scopeRel ? `${trimmedRepo}/${scopeRel}` : trimmedRepo);
}

/**
 * The local mirror folder for an **absolute remote path**. Unlike
 * {@link scopeMirrorDir} (which anchors at the workspace folder), this can
 * point above the opened folder — needed when a pnpm workspace root is
 * discovered by walking up. The path still encodes the resolved host and the
 * full absolute remote path, so a given remote folder always maps to one local
 * mirror regardless of which parent the user opened.
 */
function mirrorDirForAbs(ws: Workspace, abs: string): string {
	const parts = normalizeAbs(abs).split("/").filter(Boolean).map(sanitizeSegment);
	const hostDir = ws.remote ? (resolvedHosts.get(ws.remote) ?? sanitizeSegment(ws.remote)) : "local";
	return join(cloneRoot(), hostDir, ...parts);
}

/** Resolve `.`/`..` segments in an absolute remote path; always returns a leading `/`. */
function normalizeAbs(p: string): string {
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") out.pop();
		else out.push(seg);
	}
	return "/" + out.join("/");
}

/** The parent of an absolute remote path, or the same path when already at root. */
function parentAbs(abs: string): string {
	const norm = normalizeAbs(abs);
	const idx = norm.lastIndexOf("/");
	return idx <= 0 ? "/" : norm.slice(0, idx);
}

/** A remote Uri for an absolute path on the same host as the workspace folder. */
function remoteUriAt(ws: Workspace, abs: string): vscode.Uri {
	return ws.folder.uri.with({ path: normalizeAbs(abs) });
}

/**
 * Whether a single path segment matches one of `patterns`. Used to skip whole
 * directories when walking or pruning. The default `patterns` is the always-on
 * {@link DEFAULT_EXCLUDES}; per-scope sync passes its own combined list.
 */
function isExcluded(segment: string, patterns: readonly string[] = DEFAULT_EXCLUDES): boolean {
	for (const pattern of patterns) {
		if (pattern.includes("*")) {
			try {
				const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
				if (re.test(segment)) return true;
			} catch {
				// Bad user pattern — skip it rather than crash the whole walk.
			}
		} else if (pattern === segment) {
			return true;
		}
	}
	return false;
}

/**
 * Compile one glob (like `*.md`, `docs/**`, or `LICENSE.*`) to a RegExp.
 *
 * If the pattern contains `/`, it's matched against the scope-relative path;
 * otherwise it's matched against the file's basename. Supports `*` (any
 * characters except `/`), `**` (any characters including `/`), and `?` (any
 * single non-`/` character). Returns `undefined` if the pattern can't be
 * compiled.
 */
function compileGlob(g: string): { re: RegExp; pathMode: boolean } | undefined {
	try {
		const pathMode = g.includes("/");
		// Escape regex metas including `*` and `?` so subsequent replacements
		// target their escaped forms (`\*`, `\?`) — otherwise raw `*`/`?` would
		// reach the RegExp constructor as quantifiers and either error or match
		// the wrong thing.
		let re = g.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
		// **/x  →  (?:.*/)?x   ;   x/**  →  x(?:/.*)?   ;   **  →  .*
		re = re.replace(/\\\*\\\*\//g, "(?:.*/)?").replace(/\/\\\*\\\*/g, "(?:/.*)?").replace(/\\\*\\\*/g, ".*");
		re = re.replace(/\\\*/g, "[^/]*").replace(/\\\?/g, "[^/]");
		return { re: new RegExp(`^${re}$`), pathMode };
	} catch {
		return undefined;
	}
}

/** Whether any glob in the list matches the file (by basename or full path). */
function matchesAnyGlob(globs: readonly string[], name: string, fullRel: string): boolean {
	for (const g of globs) {
		const compiled = compileGlob(g);
		if (!compiled) continue;
		if (compiled.re.test(compiled.pathMode ? fullRel : name)) return true;
	}
	return false;
}

/** A single rule from a `.gitignore` file, compiled to a regex. */
interface IgnoreRule {
	pattern: RegExp;
	/** True if the original line ended with `/` — matches only directories. */
	dirOnly: boolean;
}

/**
 * Compile one `.gitignore` line to a rule. Returns `undefined` for blank
 * lines, `#` comments, and negation patterns (`!keep.me` — unsupported here;
 * users should reach for `includeFiles` to force-include something).
 */
function compileIgnore(rawLine: string): IgnoreRule | undefined {
	let p = rawLine.replace(/\r$/, "");
	// Trim trailing whitespace but preserve escaped trailing space (rare).
	p = p.replace(/(?<!\\)\s+$/, "");
	if (!p || p.startsWith("#") || p.startsWith("!")) return undefined;
	let dirOnly = false;
	if (p.endsWith("/")) {
		dirOnly = true;
		p = p.slice(0, -1);
	}
	// A leading `/` or an internal `/` anchors the pattern to the scope root.
	let anchored = false;
	if (p.startsWith("/")) {
		anchored = true;
		p = p.slice(1);
	} else if (p.includes("/")) {
		anchored = true;
	}
	try {
		// Same escape-then-substitute approach as compileGlob — see its
		// comment for why `*` and `?` must be in the escape set.
		let re = p.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
		re = re.replace(/\\\*\\\*\//g, "(?:.*/)?").replace(/\/\\\*\\\*/g, "(?:/.*)?").replace(/\\\*\\\*/g, ".*");
		re = re.replace(/\\\*/g, "[^/]*").replace(/\\\?/g, "[^/]");
		const final = anchored ? new RegExp(`^${re}(?:/.*)?$`) : new RegExp(`(?:^|.*/)${re}(?:/.*)?$`);
		return { pattern: final, dirOnly };
	} catch {
		return undefined;
	}
}

/** Whether any compiled gitignore rule matches a scope-relative path. */
function isGitignored(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean {
	for (const r of rules) {
		if (r.dirOnly && !isDir) continue;
		if (r.pattern.test(rel)) return true;
	}
	return false;
}

/**
 * Read the `.gitignore` at the root of a remote scope and compile its rules.
 *
 * Returns an empty list if the file is missing or unreadable — the
 * surrounding sync continues as if `.gitignore` was empty rather than failing.
 */
async function loadGitignore(remoteRoot: vscode.Uri): Promise<IgnoreRule[]> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(remoteRoot, GITIGNORE_REL));
		const text = Buffer.from(bytes).toString("utf8");
		const rules: IgnoreRule[] = [];
		for (const line of text.split(/\r?\n/)) {
			const r = compileIgnore(line);
			if (r) rules.push(r);
		}
		return rules;
	} catch {
		return [];
	}
}

/**
 * Normalize a workspace-relative path: resolve `.` and `..` segments, drop
 * duplicate `/`. Returns `".."` if the path escapes the workspace root.
 */
function normalizeRel(rel: string): string {
	const parts = rel.split("/").filter((s) => s && s !== ".");
	const out: string[] = [];
	for (const p of parts) {
		if (p === "..") {
			if (out.length === 0) return "..";
			out.pop();
		} else {
			out.push(p);
		}
	}
	return out.join("/");
}

/**
 * Drop any scope already covered by another scope in the list — used to
 * collapse overlapping syncs, so we don't sync a child after its parent (the
 * parent already covers it) and so a per-scope prune can't delete files that
 * actually belong to a nested scope's mirror.
 */
function dedupeScopes(scopes: string[]): string[] {
	const unique = [...new Set(scopes)].sort((a, b) => a.length - b.length);
	const kept: string[] = [];
	for (const s of unique) {
		const covered = kept.some((k) => k === "" || s === k || s.startsWith(k + "/"));
		if (!covered) kept.push(s);
	}
	return kept;
}

/**
 * Resolve a config's `include` array to absolute workspace-relative paths.
 * Skips entries that would escape the workspace root and logs them.
 */
function resolveExtraScopes(extras: readonly string[] | undefined, packageRel: string): string[] {
	if (!extras) return [];
	const out: string[] = [];
	for (const raw of extras) {
		const combined = packageRel ? `${packageRel}/${raw}` : raw;
		const normalized = normalizeRel(combined);
		if (normalized === ".." || normalized.startsWith("../")) {
			output.appendLine(`[deskport] include "${raw}" escapes workspace root, skipped`);
			continue;
		}
		out.push(normalized);
	}
	return out;
}

/** Build a {@link ScopeFilter} for one scope from its package's config. */
async function buildScopeFilter(remoteRoot: vscode.Uri, cfg: LauncherConfig | undefined): Promise<ScopeFilter> {
	const respectGit = cfg?.respectGitignore !== false;
	const ignoreRules = respectGit ? await loadGitignore(remoteRoot) : [];
	return {
		ignoreRules,
		excludeFiles: [...DEFAULT_FILE_EXCLUDES, ...(cfg?.excludeFiles ?? [])],
		includeFiles: cfg?.includeFiles ?? []
	};
}

/** The effective directory-segment exclude list for a package config. */
function scopeExcludes(cfg: LauncherConfig | undefined): string[] {
	return [...DEFAULT_EXCLUDES, ...(cfg?.excludes ?? [])];
}

/**
 * How many directory levels to walk up looking for a `pnpm-workspace.yaml`.
 * A per-package `workspaceMaxHeight` in config.json wins; otherwise the
 * `deskport.workspaceMaxHeight` setting; otherwise {@link DEFAULT_WORKSPACE_MAX_HEIGHT}.
 * `0` (or negative) disables the walk.
 */
function effectiveMaxHeight(cfg: LauncherConfig | undefined): number {
	if (typeof cfg?.workspaceMaxHeight === "number") return cfg.workspaceMaxHeight;
	return vscode.workspace
		.getConfiguration("deskport", workspace?.folder.uri)
		.get<number>("workspaceMaxHeight", DEFAULT_WORKSPACE_MAX_HEIGHT);
}

/** Parse JSON from a remote Uri, returning `undefined` if missing or invalid. */
async function readRemoteJson<T>(uri: vscode.Uri): Promise<T | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
	} catch {
		return undefined;
	}
}

/**
 * Subset of the target package's `package.json` consulted at launch time.
 * `name` feeds the `pnpm install --filter "<name>..."` rewrite; the four dep
 * sections gate the walk-up — a package without any `workspace:*` deps does
 * not need pnpm workspace linkage to install correctly.
 */
interface TargetPkgJson {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

/** True iff any dep section of the package contains at least one `workspace:*` entry. */
function pkgHasWorkspaceDeps(pkg: TargetPkgJson): boolean {
	const sections = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies];
	for (const section of sections) {
		if (!section) continue;
		for (const spec of Object.values(section)) {
			if (typeof spec === "string" && spec.startsWith("workspace:")) return true;
		}
	}
	return false;
}

/**
 * Walk up from `startAbs` (an absolute remote path) up to `maxHeight` levels,
 * returning the first directory that contains a `pnpm-workspace.yaml` — i.e.
 * the pnpm workspace root, found the same way pnpm itself finds it. Level 0 is
 * `startAbs` (a single-package workspace), so `maxHeight` parents are checked
 * above it. Returns `undefined` when none is found within the cap.
 */
async function discoverPnpmRoot(ws: Workspace, startAbs: string, maxHeight: number): Promise<string | undefined> {
	if (maxHeight < 1) return undefined; // 0 (or negative) disables the walk-up entirely
	let dir = normalizeAbs(startAbs);
	for (let level = 0; level <= maxHeight; level++) {
		try {
			await vscode.workspace.fs.stat(remoteUriAt(ws, `${dir}/${PNPM_WORKSPACE_FILE}`));
			return dir;
		} catch {
			/* not here — climb */
		}
		const parent = parentAbs(dir);
		if (parent === dir) break; // reached the filesystem root
		dir = parent;
	}
	return undefined;
}

/** Strip surrounding single/double quotes from a YAML scalar. */
function stripQuotes(s: string): string {
	const t = s.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
	return t;
}

/**
 * Read the `packages:` globs from a `pnpm-workspace.yaml`. Handles the common
 * block-list form (`packages:` then `  - "glob"` lines) and the inline-array
 * form (`packages: ["a/*", "b/*"]`). This is a deliberately small parser — it
 * only needs the package globs, not arbitrary YAML — and ignores everything
 * else (`catalog:`, `catalogs:`, etc.).
 */
async function readPnpmWorkspaceGlobs(ws: Workspace, rootAbs: string): Promise<string[]> {
	let text: string;
	try {
		const bytes = await vscode.workspace.fs.readFile(remoteUriAt(ws, `${rootAbs}/${PNPM_WORKSPACE_FILE}`));
		text = Buffer.from(bytes).toString("utf8");
	} catch {
		return [];
	}
	const globs: string[] = [];
	let inPackages = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/\r$/, "");
		const keyMatch = line.match(/^packages\s*:(.*)$/);
		if (keyMatch) {
			const inline = keyMatch[1]!.trim();
			if (inline.startsWith("[")) {
				for (const item of inline.replace(/^\[/, "").replace(/\].*$/, "").split(","))
					if (item.trim()) globs.push(stripQuotes(item));
			} else {
				inPackages = true;
			}
			continue;
		}
		if (!inPackages) continue;
		const item = line.match(/^\s*-\s*(.+?)\s*$/);
		if (item) {
			globs.push(stripQuotes(item[1]!));
		} else if (/^\S/.test(line)) {
			inPackages = false; // dedented to a new top-level key — block ended
		}
	}
	return globs;
}

/** Subdirectory names under an absolute remote path, skipping default-excluded dirs. */
async function listRemoteDirs(ws: Workspace, abs: string): Promise<string[]> {
	try {
		const entries = await vscode.workspace.fs.readDirectory(remoteUriAt(ws, abs));
		return entries
			.filter(([name, type]) => type & vscode.FileType.Directory && !isExcluded(name))
			.map(([name]) => name);
	} catch {
		return [];
	}
}

/**
 * Expand one workspace glob (already split into segments) against the remote
 * tree, collecting matching absolute directory paths into `out`. Supports the
 * forms pnpm workspaces use in practice: literal segments, `*`/`?` wildcards
 * (one level), and `**` (any depth). `node_modules`/`.git`/etc. are never
 * descended (see {@link listRemoteDirs}).
 */
async function expandWorkspaceGlob(ws: Workspace, baseAbs: string, segs: string[], out: Set<string>): Promise<void> {
	if (segs.length === 0) {
		out.add(normalizeAbs(baseAbs));
		return;
	}
	const [head, ...rest] = segs;
	if (head === "**") {
		await expandWorkspaceGlob(ws, baseAbs, rest, out); // ** matches zero segments
		for (const child of await listRemoteDirs(ws, baseAbs))
			await expandWorkspaceGlob(ws, `${baseAbs}/${child}`, segs, out); // …and any depth
		return;
	}
	if (head!.includes("*") || head!.includes("?")) {
		const compiled = compileGlob(head!);
		for (const child of await listRemoteDirs(ws, baseAbs))
			if (!compiled || compiled.re.test(child)) await expandWorkspaceGlob(ws, `${baseAbs}/${child}`, rest, out);
		return;
	}
	await expandWorkspaceGlob(ws, `${baseAbs}/${head}`, rest, out);
}

/**
 * Build the workspace's `name → absolute-dir` map by expanding the
 * `pnpm-workspace.yaml` globs and reading each member's `package.json` name.
 * Members without a readable `package.json` (or a `name`) are skipped.
 */
async function enumerateWorkspaceMembers(ws: Workspace, rootAbs: string, globs: string[]): Promise<Map<string, string>> {
	const dirs = new Set<string>();
	for (const glob of globs) {
		if (glob.startsWith("!")) continue; // pnpm exclusion glob — not a member source
		await expandWorkspaceGlob(ws, rootAbs, glob.split("/").filter(Boolean), dirs);
	}
	const members = new Map<string, string>();
	for (const dir of dirs) {
		const pkg = await readRemoteJson<{ name?: string }>(remoteUriAt(ws, `${dir}/package.json`));
		if (pkg?.name) members.set(pkg.name, dir);
	}
	return members;
}

/** Dependency manifest fields scanned when following the workspace graph. */
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * Resolve the set of workspace member directories the target depends on,
 * transitively — any dependency whose name is a workspace member is followed
 * (pnpm links those regardless of the version spec). The target's own dir is
 * never included. `members` maps package name → absolute dir.
 */
async function resolveWorkspaceClosure(
	ws: Workspace,
	members: Map<string, string>,
	targetAbs: string
): Promise<string[]> {
	const closure = new Set<string>();
	const queue = [normalizeAbs(targetAbs)];
	const seen = new Set<string>(queue);
	while (queue.length) {
		const dir = queue.shift()!;
		const pkg = await readRemoteJson<Record<string, unknown>>(remoteUriAt(ws, `${dir}/package.json`));
		if (!pkg) continue;
		for (const field of DEP_FIELDS) {
			const deps = pkg[field];
			if (!deps || typeof deps !== "object") continue;
			for (const depName of Object.keys(deps as Record<string, unknown>)) {
				const depDir = members.get(depName);
				if (!depDir || seen.has(depDir)) continue;
				seen.add(depDir);
				closure.add(depDir);
				queue.push(depDir);
			}
		}
	}
	return [...closure];
}

/**
 * Resolve a config's `include` entries to absolute remote paths within a
 * discovered workspace root, dropping (and logging) any that escape it.
 */
function resolveIncludeAbs(extras: readonly string[] | undefined, packageAbs: string, rootAbs: string): string[] {
	if (!extras) return [];
	const out: string[] = [];
	for (const raw of extras) {
		const abs = normalizeAbs(`${packageAbs}/${raw}`);
		if (abs !== rootAbs && !abs.startsWith(rootAbs + "/")) {
			output.appendLine(`[deskport] include "${raw}" escapes workspace root ${rootAbs}, skipped`);
			continue;
		}
		out.push(abs);
	}
	return out;
}

/** Drop any absolute scope already covered by an ancestor scope in the list. */
function dedupeAbsScopes(abs: string[]): string[] {
	const uniq = [...new Set(abs.map(normalizeAbs))].sort((a, b) => a.length - b.length);
	const kept: string[] = [];
	for (const s of uniq) if (!kept.some((k) => s === k || s.startsWith(k + "/"))) kept.push(s);
	return kept;
}

/**
 * Rewrite a package's `install` command for a workspace-root install. A bare
 * `pnpm install` / `pnpm i` is scoped to the target package and its
 * dependencies (`--filter "<name>..."`) so a partial member set installs
 * cleanly with correct linkage. A customized command runs verbatim — the user
 * owns it.
 */
function rootInstallCommand(rawInstall: string | undefined, targetName: string | undefined): string | undefined {
	const cmd = rawInstall?.trim();
	if (!cmd) return undefined;
	if (targetName && /^pnpm(\s+(install|i))?$/.test(cmd)) return `pnpm install --filter "${targetName}..."`;
	return cmd;
}

/**
 * Copy one remote file into the mirror, skipping it when already up to date.
 *
 * A `remoteStat` may be passed in to reuse a stat the caller already did —
 * the cold sync pre-stats every file during its scan, so without this we'd
 * pay a redundant round-trip per file over the SSH bridge.
 */
async function mirrorFile(
	remote: vscode.Uri,
	localPath: string,
	remoteStat?: { size: number; mtime: number }
): Promise<boolean> {
	const rs = remoteStat ?? (await vscode.workspace.fs.stat(remote));
	try {
		const local = await statLocal(localPath);
		if (local.size === rs.size && Math.abs(local.mtimeMs - rs.mtime) < MTIME_TOLERANCE_MS) {
			return false;
		}
	} catch {
		// Not present locally — fall through and copy.
	}
	const bytes = await vscode.workspace.fs.readFile(remote);
	await mkdir(dirname(localPath), { recursive: true });
	await writeFile(localPath, bytes);
	const mtime = new Date(rs.mtime);
	await utimes(localPath, mtime, mtime).catch(() => undefined);
	return true;
}

/**
 * Recursively mirror a remote directory into the local mirror. Used by the
 * live sync watcher for incremental updates after the initial cold sync — the
 * cold sync goes through {@link scanRemote} + a flat copy loop instead, so it
 * can report real progress and survive per-file failures.
 */
async function mirrorSubtree(
	remoteDir: vscode.Uri,
	rel: string,
	mirror: string,
	excludes: readonly string[],
	filter: ScopeFilter,
	kept?: Set<string>
): Promise<number> {
	let copied = 0;
	const entries = await vscode.workspace.fs.readDirectory(remoteDir);
	for (const [name, type] of entries) {
		if (isExcluded(name, excludes)) continue;
		// Don't follow symlinks: across an SSH bridge they can point anywhere
		// (including back into the tree) and aren't something we want to copy.
		if (type & vscode.FileType.SymbolicLink) continue;
		const childRel = rel ? `${rel}/${name}` : name;
		const childRemote = vscode.Uri.joinPath(remoteDir, name);
		const isDir = !!(type & vscode.FileType.Directory);
		const isFile = !!(type & vscode.FileType.File);
		const forced = matchesAnyGlob(filter.includeFiles, name, childRel);
		if (!forced && isGitignored(filter.ignoreRules, childRel, isDir)) continue;
		if (isDir) {
			copied += await mirrorSubtree(childRemote, childRel, mirror, excludes, filter, kept);
		} else if (isFile) {
			if (!forced && matchesAnyGlob(filter.excludeFiles, name, childRel)) continue;
			kept?.add(childRel);
			if (await mirrorFile(childRemote, join(mirror, childRel))) copied++;
		}
	}
	return copied;
}

/** One remote file discovered by {@link scanRemote}: path plus its stat. */
interface ScannedFile {
	/** Workspace-relative path. */
	rel: string;
	/** Size in bytes — drives the byte-weighted progress bar. */
	size: number;
	/** mtime in ms since epoch — passed straight into {@link mirrorFile}. */
	mtime: number;
}

/**
 * Walk the remote tree and stat every file (workspace-relative path + size + mtime).
 *
 * Used by the cold sync so it knows the total byte volume *before* it starts
 * copying — the progress bar then advances by `size / totalBytes` per file
 * rather than `1 / fileCount`, which matches actual work much better when
 * file sizes vary wildly. The stats are reused inside {@link mirrorFile}, so
 * we don't pay an extra round-trip per file vs. the old "stat during copy" path.
 *
 * Defensive against symlink loops: tracks every directory URI it enters and
 * skips repeats. Symlinks themselves are skipped outright (see {@link mirrorSubtree}).
 */
async function scanRemote(
	remoteDir: vscode.Uri,
	rel: string,
	files: ScannedFile[],
	token: vscode.CancellationToken,
	visited: Set<string>,
	excludes: readonly string[],
	filter: ScopeFilter,
	onProgress: (count: number) => void
): Promise<void> {
	if (token.isCancellationRequested) return;
	const key = remoteDir.toString();
	if (visited.has(key)) return;
	visited.add(key);
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(remoteDir);
	} catch (err) {
		output.appendLine(`[deskport] scan skipped ${rel || "."}: ${(err as Error).message}`);
		return;
	}
	for (const [name, type] of entries) {
		if (token.isCancellationRequested) return;
		if (isExcluded(name, excludes)) continue;
		if (type & vscode.FileType.SymbolicLink) continue;
		const childRel = rel ? `${rel}/${name}` : name;
		const childUri = vscode.Uri.joinPath(remoteDir, name);
		const isDir = !!(type & vscode.FileType.Directory);
		const isFile = !!(type & vscode.FileType.File);
		// `includeFiles` forces a file (or every file under a forced directory)
		// back in even when a `.gitignore` or the default file-exclude list
		// would otherwise skip it — segment-level `excludes` still apply.
		const forced = matchesAnyGlob(filter.includeFiles, name, childRel);
		if (!forced && isGitignored(filter.ignoreRules, childRel, isDir)) continue;
		if (isDir) {
			await scanRemote(childUri, childRel, files, token, visited, excludes, filter, onProgress);
		} else if (isFile) {
			if (!forced && matchesAnyGlob(filter.excludeFiles, name, childRel)) continue;
			try {
				const s = await vscode.workspace.fs.stat(childUri);
				files.push({ rel: childRel, size: s.size, mtime: s.mtime });
				onProgress(files.length);
			} catch (err) {
				output.appendLine(`[deskport] scan stat skipped ${childRel}: ${(err as Error).message}`);
			}
		}
	}
}

/** Human-readable byte size for progress and log messages. */
function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Delete mirror files that no longer exist remotely (within one scope). */
async function pruneMirror(
	dir: string,
	rel: string,
	kept: Set<string>,
	excludes: readonly string[]
): Promise<number> {
	let removed = 0;
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (isExcluded(entry.name, excludes)) continue;
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		const childPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			removed += await pruneMirror(childPath, childRel, kept, excludes);
		} else if (entry.isFile() && !kept.has(childRel)) {
			await rm(childPath, { force: true });
			removed++;
		}
	}
	return removed;
}

/** Whether a cold sync ran to completion or the user cancelled it. */
type SyncResult = "ok" | "cancelled";

/** One subtree the cold sync should mirror, with the filters that apply to it. */
interface SyncJob {
	/** Scope identity: a workspace-relative path (legacy) or an absolute remote path (workspace mode). */
	scope: string;
	/** Source root: the scope's remote folder. */
	remoteRoot: vscode.Uri;
	/** Local folder this subtree mirrors into. */
	localRoot: string;
	/** Short label for progress/log messages. */
	label: string;
	/** Segment-level dir excludes for this scope ({@link DEFAULT_EXCLUDES} + config). */
	excludes: string[];
	/** File-level filter for this scope. */
	filter: ScopeFilter;
	/**
	 * When set, mirror only these specific scope-relative files instead of
	 * walking the whole subtree — used for the workspace-root manifests
	 * (`pnpm-workspace.yaml`, lockfile, …) so we pull them without dragging in
	 * the entire root directory. A files-only job never prunes (it must not
	 * delete sibling root files it doesn't own), and absent files are skipped.
	 */
	files?: string[];
}

/** Stable key for {@link activeJobs}; distinguishes a files-only scope from a subtree at the same path. */
function jobKey(job: SyncJob): string {
	return `${job.files ? "F" : "D"}:${job.scope}`;
}

/**
 * Cold-sync one or more remote subtrees into their local mirror folders,
 * driving a single byte-weighted progress bar across the whole set.
 *
 * Each job is treated as a self-contained subtree with its own filters
 * (`.gitignore`, segment excludes, file globs, force-includes). The function
 * first scans every job to compute a grand total of bytes, then copies in a
 * second pass so the progress bar reflects real work across the combined set
 * rather than resetting per-job.
 *
 * The work splits into three reported phases per job (with shared bar):
 *   1. `scanning` — walk the remote subtree to gather paths + sizes.
 *   2. `syncing N/M` — copy/refresh each file; per-file errors are logged
 *      to the output channel but do not abort the whole sync.
 *   3. `removing stale files…` — drop locally-mirrored files that no longer
 *      exist remotely inside that subtree.
 */
async function syncAll(
	jobs: SyncJob[],
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken
): Promise<SyncResult> {
	type ScannedJob = SyncJob & { found: ScannedFile[]; totalBytes: number };
	const scanned: ScannedJob[] = [];
	for (const job of jobs) {
		progress.report({ message: `scanning ${job.label}…` });
		output.appendLine(`[deskport] scanning ${job.label}…`);
		const files: ScannedFile[] = [];
		if (job.files) {
			// Files-only job: stat just the named files, skipping any that are absent.
			for (const rel of job.files) {
				try {
					const s = await vscode.workspace.fs.stat(vscode.Uri.joinPath(job.remoteRoot, ...rel.split("/")));
					files.push({ rel, size: s.size, mtime: s.mtime });
				} catch {
					/* manifest not present at this root — fine */
				}
			}
		} else {
			let lastScanReport = 0;
			await scanRemote(job.remoteRoot, "", files, token, new Set<string>(), job.excludes, job.filter, (count) => {
				const now = Date.now();
				if (now - lastScanReport >= 200) {
					progress.report({ message: `scanning ${job.label} — ${count} files found…` });
					lastScanReport = now;
				}
			});
		}
		if (token.isCancellationRequested) return "cancelled";
		const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
		output.appendLine(`[deskport] scan found ${files.length} file(s) in ${job.label}, ${formatBytes(totalBytes)}`);
		scanned.push({ ...job, found: files, totalBytes });
	}

	const grandFiles = scanned.reduce((a, j) => a + j.found.length, 0);
	const grandBytes = scanned.reduce((a, j) => a + j.totalBytes, 0);
	let processedFiles = 0;
	let copied = 0;
	let skipped = 0;
	let failed = 0;
	const fallbackStep = grandFiles > 0 ? 100 / grandFiles : 0;
	for (const j of scanned) {
		const kept = new Set<string>();
		for (const f of j.found) {
			if (token.isCancellationRequested) return "cancelled";
			kept.add(f.rel);
			const remote = vscode.Uri.joinPath(j.remoteRoot, ...f.rel.split("/").filter(Boolean));
			const localPath = join(j.localRoot, f.rel);
			try {
				if (await mirrorFile(remote, localPath, { size: f.size, mtime: f.mtime })) copied++;
				else skipped++;
			} catch (err) {
				failed++;
				output.appendLine(`[deskport] failed to mirror ${j.label}/${f.rel}: ${(err as Error).message}`);
			}
			processedFiles++;
			const step = grandBytes > 0 ? (f.size / grandBytes) * 100 : fallbackStep;
			progress.report({
				increment: step,
				message: `${processedFiles}/${grandFiles} files — ${j.label}/${f.rel}`
			});
		}
		if (token.isCancellationRequested) return "cancelled";
		let removed = 0;
		// Files-only jobs share their mirror dir with sibling files they don't
		// own (e.g. the root manifests sit beside package mirror dirs), so they
		// must never prune.
		if (!j.files) {
			progress.report({ message: `removing stale files in ${j.label}…` });
			try {
				removed = await pruneMirror(j.localRoot, "", kept, j.excludes);
			} catch (err) {
				output.appendLine(`[deskport] prune failed in ${j.label}: ${(err as Error).message}`);
			}
		}
		output.appendLine(
			`[deskport] mirror ready (${j.label}) — ${copied} updated, ${skipped} unchanged, ${removed} removed` +
				(failed > 0 ? `, ${failed} failed (see output above)` : "")
		);
	}
	return "ok";
}

/**
 * (Re)build the live FS watchers from {@link activeJobs} — one recursive
 * watcher per subtree scope, and one watcher per file for a files-only scope.
 * Rooting each watcher at its own scope (rather than one watcher over the whole
 * workspace) is what lets a scope sit *above* the opened folder — needed when a
 * pnpm workspace root is discovered by walking up. It also avoids firing for
 * unrelated siblings in a large monorepo.
 *
 * Watching a remote path outside the opened folder is best-effort: if the
 * Remote-SSH watcher doesn't deliver those events, the cold sync re-run on the
 * next launch still reconciles the mirror, so correctness never depends on it.
 */
function ensureSyncWatchers(): void {
	if (!workspace || workspace.remote === null) return;
	stopSyncWatchers();
	for (const job of activeJobs.values()) {
		const patterns = job.files
			? job.files.map((f) => new vscode.RelativePattern(job.remoteRoot, f))
			: [new vscode.RelativePattern(job.remoteRoot, "**/*")];
		for (const pattern of patterns) {
			const w = vscode.workspace.createFileSystemWatcher(pattern);
			w.onDidCreate((u) => void onScopeEvent(job, u, "upsert"));
			w.onDidChange((u) => void onScopeEvent(job, u, "upsert"));
			w.onDidDelete((u) => void onScopeEvent(job, u, "delete"));
			syncWatchers.push(w);
		}
	}
}

function stopSyncWatchers(): void {
	for (const w of syncWatchers) w.dispose();
	syncWatchers = [];
}

/**
 * Mirror a single live FS event into its scope's local mirror dir, applying
 * the same filters the cold sync used. The event's path is made relative to
 * the job's remote root directly (no `asRelativePath`, which is anchored to the
 * opened folder and can't express a scope above it).
 */
async function onScopeEvent(job: SyncJob, uri: vscode.Uri, kind: "upsert" | "delete"): Promise<void> {
	const base = job.remoteRoot.path.replace(/\/+$/, "");
	if (uri.path !== base && !uri.path.startsWith(base + "/")) return;
	const relInScope = uri.path === base ? "" : uri.path.slice(base.length + 1);
	if (job.files) {
		// Files-only scope: only the named files are mirrored, never pruned.
		if (!job.files.includes(relInScope)) return;
		if (kind === "delete") return;
		try {
			await mirrorFile(uri, join(job.localRoot, relInScope));
		} catch (err) {
			output.appendLine(`[deskport] sync skipped ${relInScope}: ${(err as Error).message}`);
		}
		return;
	}
	const segments = relInScope ? relInScope.split("/") : [];
	if (segments.some((seg) => isExcluded(seg, job.excludes))) return;
	const name = segments[segments.length - 1] ?? "";
	const forced = matchesAnyGlob(job.filter.includeFiles, name, relInScope);
	if (!forced) {
		if (kind === "upsert" && matchesAnyGlob(job.filter.excludeFiles, name, relInScope)) return;
		// isDir=false: the watcher fires per file; a directory matching a
		// gitignore rule has children whose paths match the same rule (or a prefix).
		if (isGitignored(job.filter.ignoreRules, relInScope, false)) return;
	}
	const localPath = relInScope ? join(job.localRoot, relInScope) : job.localRoot;
	try {
		if (kind === "delete") {
			await rm(localPath, { recursive: true, force: true });
			return;
		}
		const remoteStat = await vscode.workspace.fs.stat(uri);
		if (remoteStat.type & vscode.FileType.Directory) {
			await mirrorSubtree(uri, relInScope, job.localRoot, job.excludes, job.filter);
		} else {
			await mirrorFile(uri, localPath);
		}
	} catch (err) {
		output.appendLine(`[deskport] sync skipped ${relInScope}: ${(err as Error).message}`);
	}
}

/**
 * The environment for a spawned target. VSCode runs its extension host as a
 * Node-mode Electron process, so `process.env` carries `ELECTRON_RUN_AS_NODE`.
 * If that leaks into a child Electron app, the app boots as plain Node and
 * `require("electron")` yields no `app`. Strip it. FORCE_COLOR keeps the
 * child's output colored without a real TTY.
 */
function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "1" };
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}

/**
 * Signal a target's shell child and everything it launched.
 *
 * Targets run with `shell: true`, so the direct child is a `sh -c <cmd>` (or
 * `cmd /c` on Windows). A plain `child.kill()` only signals the shell; the
 * actual program (e.g. an Electron app launched via `npm run`) is the shell's
 * grandchild and would otherwise survive, reparented to init. To stop the
 * whole tree we spawn the shell with `detached: true` on POSIX — making it
 * its own process-group leader — then signal the negative pid to reach every
 * member. Windows has no equivalent process groups, so we shell out to
 * `taskkill /T /F` to walk the child tree.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
	if (!child.pid || child.exitCode !== null) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
		} catch {
			try { child.kill(signal); } catch { /* already gone */ }
		}
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		try { child.kill(signal); } catch { /* already gone */ }
	}
}

/**
 * Run a shell command, streaming its output to the channel while keeping a
 * bounded tail of it. Resolves with whether it succeeded and that tail, so a
 * caller can surface the failure detail.
 */
function runShell(commandLine: string, cwd: string): Promise<{ ok: boolean; tail: string }> {
	return new Promise((resolve) => {
		let tail = "";
		// CI=true tells package managers (pnpm in particular) that no TTY is
		// available so they should skip interactive prompts instead of bailing
		// with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` when re-installing
		// into an existing mirror. Scoped to runShell (install/setup commands)
		// so it doesn't leak into the launched target's environment.
		const env: NodeJS.ProcessEnv = { ...childEnv(), CI: "true" };
		const child = spawn(commandLine, { cwd, shell: true, env });
		const capture = (d: Buffer): void => {
			const text = d.toString();
			output.append(text);
			tail = (tail + text).slice(-OUTPUT_TAIL_LIMIT);
		};
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		child.on("error", (err) => {
			output.appendLine(`[deskport] ${commandLine} failed to start: ${err.message}`);
			resolve({ ok: false, tail: err.message });
		});
		child.on("exit", (code) => resolve({ ok: code === 0, tail: tail.trim() }));
	});
}

/**
 * Report a launch failure: log it, reveal the output channel, and show an
 * error notification. `detail` (e.g. the target's own error output) is
 * appended after a blank line, so it shows when the toast is expanded.
 */
function failLaunch(summary: string, detail?: string): void {
	clearBusy();
	output.appendLine(`[deskport] ${summary}`);
	output.show(true);
	const trimmed = detail?.trim();
	void vscode.window.showErrorMessage(`DeskPort: ${trimmed ? `${summary}\n\n${trimmed}` : summary}`);
}

async function launchTarget(id: string): Promise<void> {
	if (!workspace) return error("open a workspace folder (local or over SSH) first.");
	if (busyText) return void info("DeskPort is busy — try again in a moment.");

	// Capture into a local so narrowing survives the `await`s below.
	const ws = workspace;

	const rt = findTarget(id);
	if (!rt) return error(`no target ${JSON.stringify(id)} found in any ${CONFIG_REL}.`);

	output.appendLine("");
	output.appendLine(`[deskport] launch ${JSON.stringify(id)}`);

	// Mark the target "launching" before the toast appears so the sidebar
	// button flips to "Launching…" immediately. Cleared in startProcess once
	// the child is spawned, or below if a pre-spawn step fails or cancels.
	launchingId = id;
	void targetsProvider.refresh();

	// Sync + install run inside a progress notification. The result is the
	// directory to run from, or undefined when a step failed (already reported)
	// or the user cancelled the launch.
	const runCwd = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `DeskPort: launching ${rt.key}`, cancellable: true },
		async (progress, token): Promise<string | undefined> => {
			const targetCwdRel = rt.target.cwd?.trim() || ".";
			if (ws.remote === null) {
				const cwd = join(ws.repoPath, rt.packageRel, targetCwdRel);
				output.appendLine(`[deskport] local repo: ${cwd}`);
				return cwd;
			}
			// Resolve the SSH alias to the actual hostname before computing any
			// mirror path, so a single physical host always maps to a single
			// local mirror dir even if reached through multiple `~/.ssh/config`
			// aliases. Cheap after the first call (cached for the session).
			await resolveSshHost(ws.remote);

			// What the cold sync should produce: the subtree jobs, where the
			// target runs, where (and how) `install` runs, and a key that makes
			// install lazy per session.
			interface Plan {
				jobs: SyncJob[];
				packageDir: string;
				cwd: string;
				installCmd?: string;
				installCwd: string;
				installKey: string;
			}

			// A package config's `.gitignore`/file filters, scoped to one folder.
			const buildJob = async (scope: string, remoteRoot: vscode.Uri, label: string): Promise<SyncJob> => {
				const localRoot = mirrorDirForAbs(ws, remoteRoot.path);
				await mkdir(localRoot, { recursive: true });
				const filter = await buildScopeFilter(remoteRoot, rt.pkg.config);
				return { scope, remoteRoot, localRoot, label, excludes: scopeExcludes(rt.pkg.config), filter };
			};

			const packageAbs = normalizeAbs(`${ws.repoPath.replace(/\/+$/, "")}/${rt.packageRel}`);
			// Walk up to find a pnpm workspace root only when both gates pass:
			//   (1) the install command is pnpm-prefixed — the user has opted in
			//       to a pnpm-aware install
			//   (2) the target package actually has a `workspace:*` dep that
			//       needs a workspace root to resolve
			// A package with `npm install`, or no `workspace:*` deps, installs
			// at its own folder the same way it did pre-0.9.0 — even when a
			// `pnpm-workspace.yaml` happens to sit above it (e.g. because other
			// workspace members depend on this one via `workspace:*`).
			const installLooksPnpm = /^pnpm\b/.test((rt.pkg.config.install ?? "").trim());
			const targetPkg = installLooksPnpm
				? await readRemoteJson<TargetPkgJson>(remoteUriAt(ws, `${packageAbs}/package.json`))
				: undefined;
			const wantsWorkspaceRoot = installLooksPnpm && !!targetPkg && pkgHasWorkspaceDeps(targetPkg);
			const maxHeight = wantsWorkspaceRoot ? effectiveMaxHeight(rt.pkg.config) : 0;
			const rootAbs = await discoverPnpmRoot(ws, packageAbs, maxHeight);

			const buildPlan = async (): Promise<Plan> => {
				if (rootAbs) {
					// pnpm workspace: mirror the root manifests + this package + the
					// target's workspace dependency closure, each at its natural
					// absolute path, and install from the discovered root so pnpm
					// links `workspace:*` deps correctly.
					progress.report({ message: "resolving workspace…" });
					const globs = await readPnpmWorkspaceGlobs(ws, rootAbs);
					const members = await enumerateWorkspaceMembers(ws, rootAbs, globs);
					const closure = await resolveWorkspaceClosure(ws, members, packageAbs);
					const includeAbs = resolveIncludeAbs(rt.pkg.config.include, packageAbs, rootAbs);
					const scopeAbs = dedupeAbsScopes([packageAbs, ...closure, ...includeAbs]);

					const relTo = (abs: string): string => (abs === rootAbs ? "." : abs.slice(rootAbs.length + 1));
					const rootMirror = mirrorDirForAbs(ws, rootAbs);
					await mkdir(rootMirror, { recursive: true });
					const jobs: SyncJob[] = [
						{
							scope: rootAbs,
							remoteRoot: remoteUriAt(ws, rootAbs),
							localRoot: rootMirror,
							label: "workspace manifests",
							excludes: scopeExcludes(rt.pkg.config),
							filter: { ignoreRules: [], excludeFiles: [], includeFiles: [] },
							files: PNPM_ROOT_FILES
						}
					];
					for (const abs of scopeAbs) jobs.push(await buildJob(abs, remoteUriAt(ws, abs), relTo(abs)));

					output.appendLine(`[deskport] pnpm workspace root: ${ws.remote}:${rootAbs}`);
					output.appendLine(`[deskport] package: ${relTo(packageAbs)} (${members.size} member(s) discovered)`);
					if (closure.length || includeAbs.length)
						output.appendLine(`[deskport] dep scopes: ${scopeAbs.slice(1).map(relTo).join(", ") || "(none)"}`);

					const packageDir = mirrorDirForAbs(ws, packageAbs);
					const installCwd = rootMirror;
					const installCmd = rootInstallCommand(rt.pkg.config.install, targetPkg?.name);
					return {
						jobs,
						packageDir,
						cwd: join(packageDir, targetCwdRel),
						installCmd,
						installCwd,
						installKey: `${installCwd}::${installCmd ?? ""}`
					};
				}

				// No workspace root within reach: mirror just this package folder
				// (plus any `include` extras), exactly as before.
				const primaryScope = rt.packageRel;
				const scopes = dedupeScopes([primaryScope, ...resolveExtraScopes(rt.pkg.config.include, primaryScope)]);
				const jobs: SyncJob[] = [];
				for (const scope of scopes) {
					const segments = scope.split("/").filter(Boolean);
					const remoteRoot =
						segments.length > 0 ? vscode.Uri.joinPath(ws.folder.uri, ...segments) : ws.folder.uri;
					jobs.push(await buildJob(scope, remoteRoot, scope || "."));
				}
				const packageDir = scopeMirrorDir(ws, primaryScope);
				const remoteAbs = primaryScope ? `${ws.repoPath.replace(/\/+$/, "")}/${primaryScope}` : ws.repoPath;
				output.appendLine(`[deskport] remote: ${ws.remote}:${remoteAbs}`);
				output.appendLine(`[deskport] mirror: ${packageDir}`);
				if (scopes.length > 1) output.appendLine(`[deskport] scopes: ${scopes.map((s) => s || ".").join(", ")}`);
				return {
					jobs,
					packageDir,
					cwd: join(packageDir, targetCwdRel),
					installCmd: rt.pkg.config.install?.trim(),
					installCwd: packageDir,
					installKey: rt.packageRel
				};
			};

			// Always re-run the cold sync — the per-file `stat`-then-skip path
			// makes a no-op revalidation cheap, and it's the only thing that
			// catches changes the live watcher missed (e.g. atomic-rename
			// updates from `sed -i` that don't fire a usable watcher event).
			setBusy("syncing");
			let plan: Plan;
			try {
				plan = await buildPlan();
				const result = await syncAll(plan.jobs, progress, token);
				if (result === "cancelled") {
					output.appendLine("[deskport] sync cancelled");
					return undefined;
				}
				activeJobs.clear();
				for (const j of plan.jobs) activeJobs.set(jobKey(j), j);
			} catch (err) {
				const e = err as Error;
				if (e.stack) output.appendLine(e.stack);
				failLaunch(`initial sync failed: ${e.message}`);
				return undefined;
			}

			if (token.isCancellationRequested) {
				output.appendLine("[deskport] launch cancelled");
				return undefined;
			}

			// Install lazily, once per session per install target.
			if (plan.installCmd && !installedPackages.has(plan.installKey)) {
				progress.report({ message: `installing dependencies — ${plan.installCmd}` });
				setBusy("installing dependencies");
				output.appendLine(`[deskport] install (${plan.installCwd}): ${plan.installCmd}`);
				const install = await runShell(plan.installCmd, plan.installCwd);
				if (!install.ok) {
					failLaunch(`install failed: ${plan.installCmd}`, install.tail);
					return undefined;
				}
				installedPackages.add(plan.installKey);
			}

			if (token.isCancellationRequested) {
				output.appendLine("[deskport] launch cancelled");
				return undefined;
			}

			await mkdir(plan.cwd, { recursive: true });
			return plan.cwd;
		}
	);

	clearBusy();
	if (runCwd === undefined) {
		// Sync/install failed or was cancelled — drop the "launching…" flag so
		// the sidebar reverts to "Run". (The failure has already been reported.)
		if (launchingId === id) {
			launchingId = undefined;
			void targetsProvider.refresh();
		}
		return;
	}

	// Run the target in its terminal — a pseudoterminal whose process DeskPort
	// spawns itself (in the local extension host), so it runs on THIS machine.
	let tt = terminals.get(id);
	if (tt) {
		tt.terminal.show(true);
		startProcess(tt, rt, runCwd);
	} else {
		tt = createTargetTerminal(id);
		tt.pending = { rt, runCwd };
		terminals.set(id, tt);
		tt.terminal.show(true); // triggers the pseudoterminal's open() -> startProcess
	}
}

/** Create a pseudoterminal-backed terminal for a target. */
function createTargetTerminal(id: string): TargetTerminal {
	const writer = new vscode.EventEmitter<string>();
	const tt = { id, writer } as TargetTerminal;
	const pty: vscode.Pseudoterminal = {
		onDidWrite: writer.event,
		// open() fires when the terminal is first shown — start the queued
		// process then, so its output is not written before VSCode is listening.
		open: () => {
			if (tt.pending) {
				const { rt, runCwd } = tt.pending;
				tt.pending = undefined;
				startProcess(tt, rt, runCwd);
			}
		},
		close: () => {
			if (tt.child) killProcessTree(tt.child);
		},
		handleInput: (data) => {
			// Ctrl+C — user-initiated stop, mark stopping so the exit handler
			// reports "stopped" rather than "failed" on Windows.
			if (data === "\u0003" && tt.child) {
				tt.stopping = true;
				killProcessTree(tt.child, "SIGINT");
			}
		},
	};
	tt.terminal = vscode.window.createTerminal({
		name: `DeskPort: ${id}`,
		pty,
		iconPath: new vscode.ThemeIcon("rocket"),
	});
	return tt;
}

/** Focus a target's terminal, creating an idle one (no process) if none exists. */
function openTerminal(id: string): void {
	let tt = terminals.get(id);
	if (!tt) {
		if (!findTarget(id)) return;
		tt = createTargetTerminal(id);
		terminals.set(id, tt);
		updateStatus();
	}
	tt.terminal.show();
}

/** Spawn a target's process locally and stream it into its terminal. */
function startProcess(tt: TargetTerminal, rt: ResolvedTarget, cwd: string): void {
	if (tt.child) killProcessTree(tt.child); // a relaunch replaces any process still running
	output.appendLine(`[deskport] $ ${rt.target.command}  (cwd: ${cwd})`);
	tt.writer.fire(`\r\n\x1b[36m$ ${rt.target.command}\x1b[0m\r\n`);

	// `detached: true` on POSIX puts the shell in its own process group so
	// killProcessTree can reach descendants (e.g. an Electron app spawned by
	// `npm run`). Without this, a plain SIGTERM only reaches the shell and
	// the GUI app survives, reparented to init.
	const child = spawn(rt.target.command, {
		cwd,
		shell: true,
		env: childEnv(),
		detached: process.platform !== "win32",
	});
	tt.child = child;
	if (launchingId === tt.id) launchingId = undefined; // running takes over from "launching…"
	const stream = (d: Buffer): void => tt.writer.fire(d.toString().replace(/\r?\n/g, "\r\n"));
	child.stdout?.on("data", stream);
	child.stderr?.on("data", stream);
	child.on("error", (err) => {
		tt.writer.fire(`\r\n\x1b[31m[deskport] failed to start: ${err.message}\x1b[0m\r\n`);
		if (tt.child === child) {
			tt.child = undefined;
			tt.exit = { code: null, signal: null }; // no code + no signal -> "failed"
		}
		onActiveChange();
	});
	child.on("exit", (code, signal) => {
		tt.writer.fire(`\r\n\x1b[90m[deskport] exited (code ${code ?? 0}${signal ? `, ${signal}` : ""})\x1b[0m\r\n`);
		if (tt.child === child) {
			tt.child = undefined;
			// `taskkill /T /F` on Windows can't deliver a signal, so a stop we
			// initiated arrives here as `code: 1, signal: null` — same shape as
			// a crash. Synthesize a signal so the status reflects user intent.
			tt.exit = tt.stopping && signal == null ? { code, signal: "SIGTERM" } : { code, signal };
			tt.stopping = false;
		}
		onActiveChange();
	});

	ensureSyncWatchers();
	onActiveChange();
}

/** Stop a target's running process; its terminal stays open for relaunch. */
function stopTarget(id: string): void {
	const tt = terminals.get(id);
	if (!tt?.child) return;
	output.appendLine(`[deskport] stopping ${JSON.stringify(id)}`);
	tt.stopping = true;
	killProcessTree(tt.child);
}

/** When VSCode reports a terminal closed, kill its process and forget it. */
function forgetClosedTerminal(closed: vscode.Terminal): void {
	for (const [id, tt] of terminals) {
		if (tt.terminal === closed) {
			if (tt.child) killProcessTree(tt.child);
			terminals.delete(id);
			output.appendLine(`[deskport] terminal closed ${JSON.stringify(id)}`);
			onActiveChange();
			return;
		}
	}
}

function stopAll(): void {
	for (const tt of terminals.values()) {
		if (tt.child) killProcessTree(tt.child);
		tt.terminal.dispose();
	}
	terminals.clear();
	stopSyncWatchers();
}

/** Whether any target process is currently running. */
function anyRunning(): boolean {
	for (const tt of terminals.values()) if (tt.child) return true;
	return false;
}

function onActiveChange(): void {
	if (!anyRunning()) {
		// No process running: drop the live mirror; re-sync/-install next launch.
		stopSyncWatchers();
		activeJobs.clear();
		installedPackages.clear();
	}
	updateStatus();
}

/** Reveal the DeskPort "Targets" panel (the status bar item's click action). */
/**
 * The status-bar click action — a QuickPick listing every target, grouped by
 * package. Unlike the hover tooltip (which VSCode renders at full height), a
 * QuickPick is natively scrollable and type-to-filter, so it stays usable when
 * a workspace defines a TON of targets. Selecting a target launches it (or
 * stops it, if already running).
 */
async function showMenu(): Promise<void> {
	const targets = allTargets();
	if (targets.length === 0) {
		// Nothing to launch yet — send the user to the panel, which offers Init.
		await vscode.commands.executeCommand("deskport.targets.focus");
		return;
	}

	interface MenuItem extends vscode.QuickPickItem {
		id?: string;
		running?: boolean;
	}
	const items: MenuItem[] = [];
	let lastPkg: string | undefined;
	for (const rt of targets) {
		const pkgLabel = rt.packageRel || "workspace root";
		if (pkgLabel !== lastPkg) {
			items.push({ label: pkgLabel, kind: vscode.QuickPickItemKind.Separator });
			lastPkg = pkgLabel;
		}
		const running = terminals.get(rt.id)?.child !== undefined;
		items.push({
			label: `$(${running ? "debug-stop" : "rocket"}) ${rt.target.label ?? rt.key}`,
			description: running ? "running — select to stop" : rt.target.command,
			id: rt.id,
			running
		});
	}

	const pick = await vscode.window.showQuickPick(items, {
		title: "DeskPort — launch a dev target on this machine",
		placeHolder: "Select a target to launch or stop",
		matchOnDescription: true
	});
	if (!pick?.id) return;
	if (pick.running) stopTarget(pick.id);
	else await launchTarget(pick.id);
}

/** Re-scan the workspace for `.deskport/config.json` files and repaint the UI. */
async function refresh(): Promise<void> {
	await loadConfigs();
	registerWatchers();
	updateStatus();
}

async function initProject(): Promise<void> {
	if (!workspace) return error("open a workspace folder first.");

	const written: string[] = [];
	written.push(...(await copyResourceIfMissing("config.template.json", CONFIG_REL)));
	written.push(...(await copyResourceIfMissing("trigger.mjs", TRIGGER_MJS_REL)));

	await loadConfigs();
	updateStatus();
	registerWatchers();

	if (written.length > 0) {
		info(
			`wrote ${written.join(", ")}. Edit ${CONFIG_REL} to define your targets, ` +
				`then add ".deskport/trigger.json" to .gitignore. For a monorepo, add a ` +
				`.deskport/config.json in each package too.`
		);
	} else {
		info(".deskport/ is already initialized for this project.");
	}
}

async function copyResourceIfMissing(resource: string, destRel: string): Promise<string[]> {
	if (!workspace) return [];
	const dest = vscode.Uri.joinPath(workspace.folder.uri, destRel);
	try {
		await vscode.workspace.fs.stat(dest);
		return []; // already exists — never overwrite the user's file
	} catch {
		// not found — fall through and create it
	}
	const src = vscode.Uri.joinPath(extensionUri, "resources", resource);
	const bytes = await vscode.workspace.fs.readFile(src);
	await vscode.workspace.fs.writeFile(dest, bytes);
	return [destRel];
}

function setBusy(text: string): void {
	busyText = text;
	updateStatus();
}

function clearBusy(): void {
	busyText = undefined;
	updateStatus();
}

/** The `command:` URI a Markdown link uses to invoke an extension command. */
function commandUri(command: string, arg?: string): string {
	const query = arg === undefined ? "" : `?${encodeURIComponent(JSON.stringify([arg]))}`;
	return `command:${command}${query}`;
}

/**
 * The status bar item's tooltip — a trusted MarkdownString shown as a hover
 * card above the item. It lists every target as a clickable link grouped by
 * package; clicking one runs deskport.launch / deskport.stop directly, so the
 * hover doubles as the launch menu (no top-of-window QuickPick needed).
 */
/**
 * Largest number of target links the hover lists inline. VSCode renders a
 * status-bar tooltip at its full content height with no scrollbar, so an
 * unbounded list runs off-screen when a workspace defines a TON of targets.
 * Past this cap the hover shows a "+N more" link into the (scrollable) panel;
 * the searchable QuickPick (click the item) is the full launcher.
 */
const TOOLTIP_TARGET_CAP = 15;

function buildTooltip(): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	md.isTrusted = {
		enabledCommands: ["deskport.launch", "deskport.stop", "deskport.init", "deskport.menu", "deskport.refresh", "deskport.targets.focus"]
	};
	const ver = extensionVersion ? ` v${extensionVersion}` : "";

	if (busyText) {
		md.appendMarkdown(`$(sync~spin) **DeskPort**${ver} — ${busyText}…`);
		return md;
	}
	if (configs.length === 0) {
		if (configErrors.length > 0) {
			md.appendMarkdown(`**DeskPort**${ver}\n\n`);
			md.appendMarkdown(configErrors.map((e) => `$(error) ${e}`).join("\n\n"));
		} else {
			md.appendMarkdown(`**DeskPort**${ver}\n\n`);
			md.appendMarkdown(`[$(add) Initialize .deskport/ in this project](${commandUri("deskport.init")})`);
		}
		md.appendMarkdown(`\n\n[$(refresh) Refresh](${commandUri("deskport.refresh")})`);
		return md;
	}

	md.appendMarkdown(`**DeskPort**${ver} — launch a dev target on this machine`);
	const total = allTargets().length;
	let shown = 0;
	let truncated = false;
	for (const pkg of configs) {
		if (shown >= TOOLTIP_TARGET_CAP) {
			truncated = true;
			break;
		}
		md.appendMarkdown(`\n\n**${pkg.packageRel || "workspace root"}**\n\n`);
		const lines: string[] = [];
		for (const [key, t] of Object.entries(pkg.config.targets)) {
			if (shown >= TOOLTIP_TARGET_CAP) {
				truncated = true;
				break;
			}
			const id = targetId(pkg.packageRel, key);
			const label = t.label ?? key;
			const running = terminals.get(id)?.child !== undefined;
			lines.push(
				running
					? `$(debug-stop) [Stop “${label}”](${commandUri("deskport.stop", id)})`
					: `$(rocket) [${label}](${commandUri("deskport.launch", id)})`
			);
			shown++;
		}
		md.appendMarkdown(lines.join("\n\n"));
	}
	if (truncated) {
		md.appendMarkdown(
			`\n\n[$(list-flat) +${total - shown} more — open the panel](${commandUri("deskport.targets.focus")})`
		);
	}
	if (configErrors.length > 0) {
		md.appendMarkdown(`\n\n${configErrors.map((e) => `$(warning) ${e}`).join("\n\n")}`);
	}
	md.appendMarkdown(
		`\n\n[$(list-selection) All targets…](${commandUri("deskport.menu")})  ·  [$(refresh) Refresh](${commandUri("deskport.refresh")})`
	);
	return md;
}

function updateStatus(): void {
	const running = [...terminals.values()].filter((tt) => tt.child).length;
	if (busyText) {
		statusItem.text = `$(sync~spin) DeskPort: ${busyText}`;
	} else if (running > 0) {
		statusItem.text = `$(rocket) DeskPort (${running})`;
	} else {
		statusItem.text = "$(rocket) DeskPort";
	}
	statusItem.tooltip = buildTooltip();
	void targetsProvider.refresh();
}

function error(message: string): void {
	if (output) output.appendLine(`[deskport] ${message}`);
	void vscode.window.showErrorMessage(`DeskPort: ${message}`);
}

function info(message: string): void {
	void vscode.window.showInformationMessage(`DeskPort: ${message}`);
}
