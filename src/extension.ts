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
import { basename, dirname, join } from "node:path";

const DEFAULT_EXCLUDES = ["node_modules", ".git", "out", "dist", "release"];
const CONFIG_REL = ".deskport/config.json";
const TRIGGER_MJS_REL = ".deskport/trigger.mjs";
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
	/** Subdirectory name under the clone path. Honored only in the ROOT config. */
	mirrorName?: string;
	/** Command run once, in this config's folder, before its first target launches. */
	install?: string;
	/** Path segments to skip when mirroring. Honored only in the ROOT config. */
	excludes?: string[];
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
}

let extensionUri: vscode.Uri;
let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
let targetsProvider: TargetsViewProvider;
/** The default card icon (resources/panel-icon.svg), loaded at activation. */
let rocketSvg = "";
let workspace: Workspace | undefined;
let configs: DiscoveredConfig[] = [];
let configErrors: string[] = [];
let busyText: string | undefined;
let lastTriggerNonce: number | undefined;
let watchers: vscode.Disposable[] = [];
let syncWatcher: vscode.FileSystemWatcher | undefined;
/** Whether the whole repo has been mirrored in the current launch session. */
let mirrorSynced = false;
/** packageRel values whose `install` command has run this session. */
const installedPackages = new Set<string>();
/** Open terminals, keyed by target id — one per target, reused across launches. */
const terminals = new Map<string, TargetTerminal>();

/** The run state of a target, shown in the sidebar. */
type TargetStatus = "idle" | "running" | "exited" | "failed" | "stopped";

/** Derive a target's status from its terminal and most recent exit. */
function targetStatus(id: string): TargetStatus {
	const tt = terminals.get(id);
	if (!tt) return "idle";
	if (tt.child) return "running";
	if (!tt.exit) return "idle";
	if (tt.exit.code === 0) return "exited";
	if (tt.exit.signal) return "stopped";
	return "failed";
}

/** A target's status as text — `failed` carries its exit code. */
function statusLabel(id: string): string {
	const status = targetStatus(id);
	if (status === "failed") {
		const code = terminals.get(id)?.exit?.code;
		return code != null ? `failed (exit ${code})` : "failed";
	}
	return status;
}

/** One target rendered as a card in the sidebar webview. */
interface CardData {
	id: string;
	label: string;
	command: string;
	folder: string;
	status: TargetStatus;
	statusLabel: string;
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
async function buildViewState(): Promise<{ cards: CardData[]; errors: string[] }> {
	const cards: CardData[] = [];
	for (const rt of allTargets()) {
		cards.push({
			id: rt.id,
			label: rt.target.label ?? rt.key,
			command: rt.target.command,
			folder: rt.packageRel || "workspace root",
			status: targetStatus(rt.id),
			statusLabel: statusLabel(rt.id),
			icon: await resolveIcon(rt),
		});
	}
	return { cards, errors: configErrors };
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
.st-failed { color: var(--vscode-errorForeground, #f14c4c); }
.actions { flex: none; }
button { font: inherit; cursor: pointer; border: none; border-radius: 2px; padding: 4px 11px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:hover { background: var(--vscode-button-hoverBackground); }
button.stop { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.stop:hover { background: var(--vscode-button-secondaryHoverBackground); }
.empty { padding: 16px 12px; color: var(--vscode-descriptionForeground); }
.empty button { margin-top: 10px; }
.err { padding: 8px 12px; color: var(--vscode-errorForeground); font-size: .92em; }
</style></head><body>
<div id="root"></div>
<script nonce="${n}">
const api = acquireVsCodeApi();
const ROCKET = ${JSON.stringify(rocketSvg)};
const root = document.getElementById("root");
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
	const running = c.status === "running";
	const btn = el("button", running ? "stop" : "", running ? "Stop" : "Run");
	btn.onclick = function () { send(running ? "stop" : "launch", c.id); };
	actions.appendChild(btn);
	wrap.appendChild(actions);
	return wrap;
}
function render(state) {
	root.textContent = "";
	for (const e of state.errors || []) root.appendChild(el("div", "err", e));
	if (!state.cards || !state.cards.length) {
		const d = el("div", "empty", "No DeskPort targets found in this workspace.");
		const b = el("button", "", "Initialize Project");
		b.onclick = function () { send("init"); };
		d.appendChild(document.createElement("br"));
		d.appendChild(b);
		root.appendChild(d);
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
	output = vscode.window.createOutputChannel("DeskPort");
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
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
		vscode.commands.registerCommand("deskport.init", initProject),
		vscode.commands.registerCommand("deskport.launch", (id: string) => launchTarget(id)),
		vscode.commands.registerCommand("deskport.stop", (id: string) => stopTarget(id)),
		vscode.commands.registerCommand("deskport.openTerminal", (id: string) => openTerminal(id)),
		vscode.window.registerWebviewViewProvider("deskport.targets", targetsProvider),
		vscode.window.onDidCloseTerminal(forgetClosedTerminal),
		vscode.workspace.onDidChangeWorkspaceFolders(async () => {
			workspace = resolveWorkspace();
			await loadConfigs();
			registerWatchers();
			updateStatus();
		}),
		{ dispose: () => watchers.forEach((w) => w.dispose()) },
		{ dispose: stopSyncWatcher }
	);
	registerWatchers();

	try {
		rocketSvg = Buffer.from(
			await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, "resources", "panel-icon.svg"))
		).toString("utf8");
	} catch {
		/* the default card icon is blank if the asset cannot be read */
	}

	try {
		await loadConfigs();
	} catch (err) {
		output.appendLine(`[deskport] config scan failed: ${(err as Error).message}`);
	}
	updateStatus();
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
 * Discover every `.deskport/config.json` in the workspace (root and nested).
 *
 * Walks the tree with `vscode.workspace.fs` — the same filesystem bridge the
 * sync feature uses — rather than `findFiles`, so it works reliably when a
 * `ui`-kind extension scans a Remote-SSH workspace.
 */
async function loadConfigs(): Promise<void> {
	configs = [];
	configErrors = [];
	iconCache.clear();
	if (!workspace) return;
	await discoverConfigs(workspace.folder.uri, "");
	// Root config first, then nested ones in path order — a stable menu order.
	configs.sort((a, b) => a.packageRel.localeCompare(b.packageRel));
}

/** Recursively look for `.deskport/` folders, skipping excluded directories. */
async function discoverConfigs(dir: vscode.Uri, rel: string): Promise<void> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return;
	}
	for (const [name, type] of entries) {
		if (!(type & vscode.FileType.Directory) || isExcluded(name)) continue;
		if (name === ".deskport") {
			await readConfigFile(vscode.Uri.joinPath(dir, name, "config.json"), rel);
		} else {
			await discoverConfigs(vscode.Uri.joinPath(dir, name), rel ? `${rel}/${name}` : name);
		}
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

/** The workspace-root config, if one exists — it owns mirrorName and excludes. */
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

	watchers = [triggerWatcher, configWatcher];
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

function mirrorDir(): string {
	const name = rootConfig()?.mirrorName?.trim() || basename(workspace?.repoPath ?? "") || "devmirror";
	return join(cloneRoot(), name);
}

function isExcluded(segment: string): boolean {
	for (const pattern of rootConfig()?.excludes ?? DEFAULT_EXCLUDES) {
		if (pattern.includes("*")) {
			const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
			if (re.test(segment)) return true;
		} else if (pattern === segment) {
			return true;
		}
	}
	return false;
}

/** Copy one remote file into the mirror, skipping it when already up to date. */
async function mirrorFile(remote: vscode.Uri, localPath: string): Promise<boolean> {
	const remoteStat = await vscode.workspace.fs.stat(remote);
	try {
		const local = await statLocal(localPath);
		if (local.size === remoteStat.size && Math.abs(local.mtimeMs - remoteStat.mtime) < MTIME_TOLERANCE_MS) {
			return false;
		}
	} catch {
		// Not present locally — fall through and copy.
	}
	const bytes = await vscode.workspace.fs.readFile(remote);
	await mkdir(dirname(localPath), { recursive: true });
	await writeFile(localPath, bytes);
	const mtime = new Date(remoteStat.mtime);
	await utimes(localPath, mtime, mtime).catch(() => undefined);
	return true;
}

/** Recursively mirror a remote directory into the local mirror. */
async function mirrorSubtree(remoteDir: vscode.Uri, rel: string, mirror: string, kept?: Set<string>): Promise<number> {
	let copied = 0;
	const entries = await vscode.workspace.fs.readDirectory(remoteDir);
	for (const [name, type] of entries) {
		if (isExcluded(name)) continue;
		const childRel = rel ? `${rel}/${name}` : name;
		const childRemote = vscode.Uri.joinPath(remoteDir, name);
		if (type & vscode.FileType.Directory) {
			copied += await mirrorSubtree(childRemote, childRel, mirror, kept);
		} else if (type & vscode.FileType.File) {
			kept?.add(childRel);
			if (await mirrorFile(childRemote, join(mirror, childRel))) copied++;
		}
	}
	return copied;
}

/** Delete mirror files that no longer exist remotely. */
async function pruneMirror(dir: string, rel: string, kept: Set<string>): Promise<number> {
	let removed = 0;
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (isExcluded(entry.name)) continue;
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		const childPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			removed += await pruneMirror(childPath, childRel, kept);
		} else if (entry.isFile() && !kept.has(childRel)) {
			await rm(childPath, { force: true });
			removed++;
		}
	}
	return removed;
}

async function syncAll(ws: Workspace, mirror: string): Promise<void> {
	const kept = new Set<string>();
	const copied = await mirrorSubtree(ws.folder.uri, "", mirror, kept);
	const removed = await pruneMirror(mirror, "", kept);
	output.appendLine(`[deskport] mirror ready — ${copied} file(s) updated, ${removed} removed`);
}

function ensureSyncWatcher(): void {
	if (!workspace || workspace.remote === null || syncWatcher) return;
	syncWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspace.folder, "**/*"));
	syncWatcher.onDidCreate((u) => void onSyncEvent(u, "upsert"));
	syncWatcher.onDidChange((u) => void onSyncEvent(u, "upsert"));
	syncWatcher.onDidDelete((u) => void onSyncEvent(u, "delete"));
}

function stopSyncWatcher(): void {
	syncWatcher?.dispose();
	syncWatcher = undefined;
}

async function onSyncEvent(uri: vscode.Uri, kind: "upsert" | "delete"): Promise<void> {
	if (!workspace) return;
	const rel = vscode.workspace.asRelativePath(uri, false);
	if (rel.split("/").some(isExcluded)) return;

	const localPath = join(mirrorDir(), rel);
	try {
		if (kind === "delete") {
			await rm(localPath, { recursive: true, force: true });
			return;
		}
		const remoteStat = await vscode.workspace.fs.stat(uri);
		if (remoteStat.type & vscode.FileType.Directory) {
			await mirrorSubtree(uri, rel, mirrorDir());
		} else {
			await mirrorFile(uri, localPath);
		}
	} catch (err) {
		output.appendLine(`[deskport] sync skipped ${rel}: ${(err as Error).message}`);
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
 * Run a shell command, streaming its output to the channel while keeping a
 * bounded tail of it. Resolves with whether it succeeded and that tail, so a
 * caller can surface the failure detail.
 */
function runShell(commandLine: string, cwd: string): Promise<{ ok: boolean; tail: string }> {
	return new Promise((resolve) => {
		let tail = "";
		const child = spawn(commandLine, { cwd, shell: true, env: childEnv() });
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

	// Where the target runs: <base>/<package folder>/<target cwd>.
	const relFromRoot = joinRel(rt.packageRel, rt.target.cwd?.trim() || ".");

	// Sync + install run inside a progress notification. The result is the
	// directory to run from, or undefined when a step failed (already reported).
	const runCwd = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `DeskPort: launching ${rt.key}`, cancellable: false },
		async (progress): Promise<string | undefined> => {
			if (ws.remote === null) {
				const cwd = join(ws.repoPath, relFromRoot);
				output.appendLine(`[deskport] local repo: ${cwd}`);
				return cwd;
			}
			const mirror = mirrorDir();
			const cwd = join(mirror, relFromRoot);

			// Cold start: mirror the whole repo once per launch session.
			if (!mirrorSynced) {
				output.appendLine(`[deskport] remote: ${ws.remote}:${ws.repoPath}`);
				output.appendLine(`[deskport] mirror: ${mirror}`);
				progress.report({ message: "syncing repo to this machine…" });
				setBusy("syncing");
				try {
					await mkdir(mirror, { recursive: true });
					await syncAll(ws, mirror);
				} catch (err) {
					failLaunch(`initial sync failed: ${(err as Error).message}`);
					return undefined;
				}
				mirrorSynced = true;
			}

			// Per-package install, lazily on this package's first launch.
			const installCmd = rt.pkg.config.install?.trim();
			if (installCmd && !installedPackages.has(rt.packageRel)) {
				progress.report({ message: `installing dependencies — ${installCmd}` });
				setBusy(`installing ${rt.packageRel || "."}`);
				output.appendLine(`[deskport] install (${rt.packageRel || "."}): ${installCmd}`);
				const install = await runShell(installCmd, join(mirror, rt.packageRel));
				if (!install.ok) {
					failLaunch(`install failed: ${installCmd}`, install.tail);
					return undefined;
				}
				installedPackages.add(rt.packageRel);
			}

			await mkdir(cwd, { recursive: true });
			return cwd;
		}
	);

	clearBusy();
	if (runCwd === undefined) return; // a sync/install step failed and reported it

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
		close: () => tt.child?.kill(),
		handleInput: (data) => {
			if (data === "\u0003") tt.child?.kill("SIGINT"); // Ctrl+C
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
	tt.child?.kill(); // a relaunch replaces any process still running
	output.appendLine(`[deskport] $ ${rt.target.command}  (cwd: ${cwd})`);
	tt.writer.fire(`\r\n\x1b[36m$ ${rt.target.command}\x1b[0m\r\n`);

	const child = spawn(rt.target.command, { cwd, shell: true, env: childEnv() });
	tt.child = child;
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
			tt.exit = { code, signal };
		}
		onActiveChange();
	});

	ensureSyncWatcher();
	onActiveChange();
}

/** Stop a target's running process; its terminal stays open for relaunch. */
function stopTarget(id: string): void {
	const tt = terminals.get(id);
	if (!tt?.child) return;
	output.appendLine(`[deskport] stopping ${JSON.stringify(id)}`);
	tt.child.kill();
}

/** When VSCode reports a terminal closed, kill its process and forget it. */
function forgetClosedTerminal(closed: vscode.Terminal): void {
	for (const [id, tt] of terminals) {
		if (tt.terminal === closed) {
			tt.child?.kill();
			terminals.delete(id);
			output.appendLine(`[deskport] terminal closed ${JSON.stringify(id)}`);
			onActiveChange();
			return;
		}
	}
}

function stopAll(): void {
	for (const tt of terminals.values()) {
		tt.child?.kill();
		tt.terminal.dispose();
	}
	terminals.clear();
	stopSyncWatcher();
}

/** Whether any target process is currently running. */
function anyRunning(): boolean {
	for (const tt of terminals.values()) if (tt.child) return true;
	return false;
}

function onActiveChange(): void {
	if (!anyRunning()) {
		// No process running: drop the live mirror; re-sync/-install next launch.
		stopSyncWatcher();
		mirrorSynced = false;
		installedPackages.clear();
	}
	updateStatus();
}

/** Reveal the DeskPort "Targets" panel (the status bar item's click action). */
async function showMenu(): Promise<void> {
	await vscode.commands.executeCommand("deskport.targets.focus");
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
function buildTooltip(): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	md.isTrusted = { enabledCommands: ["deskport.launch", "deskport.stop", "deskport.init"] };

	if (busyText) {
		md.appendMarkdown(`$(sync~spin) **DeskPort** — ${busyText}…`);
		return md;
	}
	if (configs.length === 0) {
		if (configErrors.length > 0) {
			md.appendMarkdown(configErrors.map((e) => `$(error) ${e}`).join("\n\n"));
		} else {
			md.appendMarkdown("**DeskPort**\n\n");
			md.appendMarkdown(`[$(add) Initialize .deskport/ in this project](${commandUri("deskport.init")})`);
		}
		return md;
	}

	md.appendMarkdown("**DeskPort** — launch a dev target on this machine");
	for (const pkg of configs) {
		md.appendMarkdown(`\n\n**${pkg.packageRel || "workspace root"}**\n\n`);
		const lines: string[] = [];
		for (const [key, t] of Object.entries(pkg.config.targets)) {
			const id = targetId(pkg.packageRel, key);
			const label = t.label ?? key;
			const running = terminals.get(id)?.child !== undefined;
			lines.push(
				running
					? `$(debug-stop) [Stop “${label}”](${commandUri("deskport.stop", id)})`
					: `$(rocket) [${label}](${commandUri("deskport.launch", id)})`
			);
		}
		md.appendMarkdown(lines.join("\n\n"));
	}
	if (configErrors.length > 0) {
		md.appendMarkdown(`\n\n${configErrors.map((e) => `$(warning) ${e}`).join("\n\n")}`);
	}
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
