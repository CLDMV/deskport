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

interface TargetConfig {
	/** Shell command to run (from the synced repo). */
	command: string;
	/** Display name; defaults to the target key. */
	label?: string;
	/** Directory to run from, relative to this config's folder; defaults to ".". */
	cwd?: string;
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

let extensionUri: vscode.Uri;
let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
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
const running = new Map<string, ChildProcess>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	extensionUri = context.extensionUri;
	output = vscode.window.createOutputChannel("DeskPort");
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusItem.command = "deskport.menu";

	workspace = resolveWorkspace();
	await loadConfigs();
	updateStatus();
	statusItem.show();

	context.subscriptions.push(
		output,
		statusItem,
		vscode.commands.registerCommand("deskport.menu", showMenu),
		vscode.commands.registerCommand("deskport.init", initProject),
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

/** Discover every `.deskport/config.json` in the workspace (root and nested). */
async function loadConfigs(): Promise<void> {
	configs = [];
	configErrors = [];
	if (!workspace) return;

	const found = await vscode.workspace.findFiles(
		new vscode.RelativePattern(workspace.folder, "**/.deskport/config.json"),
		"**/node_modules/**"
	);
	for (const uri of found) {
		// rel looks like "packages/foo/.deskport/config.json" — drop the last
		// two segments (".deskport/config.json") to get the package folder.
		const rel = vscode.workspace.asRelativePath(uri, false);
		const packageRel = rel.split("/").slice(0, -2).join("/");

		let bytes: Uint8Array;
		try {
			bytes = await vscode.workspace.fs.readFile(uri);
		} catch {
			continue;
		}
		try {
			const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as LauncherConfig;
			if (!parsed.targets || typeof parsed.targets !== "object" || Object.keys(parsed.targets).length === 0) {
				configErrors.push(`${rel} defines no "targets".`);
				continue;
			}
			configs.push({ packageRel, config: parsed });
		} catch (err) {
			configErrors.push(`${rel} is not valid JSON: ${(err as Error).message}`);
		}
	}
	// Root config first, then nested ones in path order — a stable menu order.
	configs.sort((a, b) => a.packageRel.localeCompare(b.packageRel));
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

function streamProcess(child: ChildProcess, name: string, resolve: (ok: boolean) => void): void {
	child.stdout?.on("data", (d: Buffer) => output.append(d.toString()));
	child.stderr?.on("data", (d: Buffer) => output.append(d.toString()));
	child.on("error", (err) => {
		output.appendLine(`[deskport] ${name} failed to start: ${err.message}`);
		resolve(false);
	});
	child.on("exit", (code) => resolve(code === 0));
}

function runShell(commandLine: string, cwd: string): Promise<boolean> {
	return new Promise((resolve) => streamProcess(spawn(commandLine, { cwd, shell: true }), commandLine, resolve));
}

async function launchTarget(id: string): Promise<void> {
	if (!workspace) return error("open a workspace folder (local or over SSH) first.");
	if (busyText) return void info("DeskPort is busy — try again in a moment.");

	// Capture into a local so narrowing survives the `await`s below.
	const ws = workspace;

	const rt = findTarget(id);
	if (!rt) return error(`no target ${JSON.stringify(id)} found in any ${CONFIG_REL}.`);
	if (running.has(id)) {
		output.show(true);
		return void info(`target ${JSON.stringify(rt.key)} is already running.`);
	}

	output.show(true);
	output.appendLine("");
	output.appendLine(`[deskport] launch ${JSON.stringify(id)}`);

	// Where the target runs: <base>/<package folder>/<target cwd>.
	const relFromRoot = joinRel(rt.packageRel, rt.target.cwd?.trim() || ".");
	let runCwd: string;

	if (ws.remote === null) {
		runCwd = join(ws.repoPath, relFromRoot);
		output.appendLine(`[deskport] local repo: ${runCwd}`);
	} else {
		const mirror = mirrorDir();
		runCwd = join(mirror, relFromRoot);

		// Cold start: mirror the whole repo once per launch session. While any
		// target runs, the sync watcher keeps the mirror current.
		if (!mirrorSynced) {
			await mkdir(mirror, { recursive: true });
			output.appendLine(`[deskport] remote: ${ws.remote}:${ws.repoPath}`);
			output.appendLine(`[deskport] mirror: ${mirror}`);

			setBusy("syncing");
			try {
				await syncAll(ws, mirror);
			} catch (err) {
				clearBusy();
				return error(`initial sync failed: ${(err as Error).message}`);
			}
			mirrorSynced = true;
		}

		// Per-package install: run this config's `install` lazily, the first
		// time one of its targets launches this session.
		const installCmd = rt.pkg.config.install?.trim();
		if (installCmd && !installedPackages.has(rt.packageRel)) {
			const installCwd = join(mirror, rt.packageRel);
			setBusy(`installing ${rt.packageRel || "."}`);
			output.appendLine(`[deskport] install (${rt.packageRel || "."}): ${installCmd}`);
			if (!(await runShell(installCmd, installCwd))) {
				clearBusy();
				return error(`install command failed: ${installCmd}`);
			}
			installedPackages.add(rt.packageRel);
		}
	}

	setBusy(`launching ${rt.key}`);
	output.appendLine(`[deskport] $ ${rt.target.command}  (cwd: ${runCwd})`);
	const child = spawn(rt.target.command, { cwd: runCwd, shell: true });
	child.stdout?.on("data", (d: Buffer) => output.append(d.toString()));
	child.stderr?.on("data", (d: Buffer) => output.append(d.toString()));
	child.on("error", (err) => {
		output.appendLine(`[deskport] ${JSON.stringify(id)} failed to start: ${err.message}`);
		running.delete(id);
		onRunningChange();
	});
	child.on("exit", (code) => {
		output.appendLine(`[deskport] ${JSON.stringify(id)} exited (code ${code ?? 0})`);
		running.delete(id);
		onRunningChange();
	});

	running.set(id, child);
	ensureSyncWatcher();
	clearBusy();
}

function stopTarget(id: string): void {
	const child = running.get(id);
	if (!child) return;
	output.appendLine(`[deskport] stopping ${JSON.stringify(id)}`);
	child.kill();
}

function stopAll(): void {
	for (const id of [...running.keys()]) stopTarget(id);
	stopSyncWatcher();
}

function onRunningChange(): void {
	if (running.size === 0) {
		// Session over: drop the live mirror, and re-sync/-install next time.
		stopSyncWatcher();
		mirrorSynced = false;
		installedPackages.clear();
	}
	updateStatus();
}

async function showMenu(): Promise<void> {
	if (!workspace) return error("open a workspace folder (local or over SSH) first.");
	for (const e of configErrors) output.appendLine(`[deskport] ${e}`);

	if (configs.length === 0) {
		if (configErrors.length > 0) return error(configErrors.join("; "));
		const pick = await vscode.window.showQuickPick(["Initialize .deskport/ in this project"], {
			placeHolder: "DeskPort is not set up for this project",
		});
		if (pick) await initProject();
		return;
	}

	type Item = vscode.QuickPickItem & { id?: string; isRunning?: boolean };
	const items: Item[] = [];
	for (const pkg of configs) {
		items.push({ label: pkg.packageRel || "workspace root", kind: vscode.QuickPickItemKind.Separator });
		for (const [key, t] of Object.entries(pkg.config.targets)) {
			const id = targetId(pkg.packageRel, key);
			const isRunning = running.has(id);
			items.push({
				label: `${isRunning ? "$(debug-stop)" : "$(rocket)"} ${t.label ?? key}`,
				description: isRunning ? "running — select to stop" : "select to launch",
				detail: t.command,
				id,
				isRunning,
			});
		}
	}
	const chosen = await vscode.window.showQuickPick(items, {
		placeHolder: "DeskPort — select a target",
	});
	if (!chosen?.id) return;
	if (chosen.isRunning) stopTarget(chosen.id);
	else await launchTarget(chosen.id);
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

function updateStatus(): void {
	if (busyText) {
		statusItem.text = `$(sync~spin) DeskPort: ${busyText}`;
		statusItem.tooltip = busyText;
	} else if (running.size > 0) {
		statusItem.text = `$(debug-stop) DeskPort (${running.size})`;
		statusItem.tooltip = `${running.size} target(s) running locally — click to manage`;
	} else {
		statusItem.text = "$(rocket) DeskPort";
		statusItem.tooltip =
			configs.length > 0
				? "Click to launch a dev target on this machine"
				: (configErrors[0] ?? "No .deskport/config.json — click to initialize");
	}
}

function error(message: string): void {
	if (output) output.appendLine(`[deskport] ${message}`);
	void vscode.window.showErrorMessage(`DeskPort: ${message}`);
}

function info(message: string): void {
	void vscode.window.showInformationMessage(`DeskPort: ${message}`);
}
