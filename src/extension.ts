/**
 * Remote Dev Launcher — VSCode extension.
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
 * Targets are defined per project in `.devlauncher/config.json`. Each target
 * is a shell command run from a directory in the synced repo. A target can be
 * started from the status-bar menu, or from the REMOTE host by writing a
 * trigger file (resources/trigger.mjs) — which a remote `npm run` script can
 * do, giving a "remote command -> local launch" flow.
 *
 * Local requirements: only what a target command itself needs (node, pnpm, …).
 */

import * as vscode from "vscode";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, rm, stat as statLocal, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const DEFAULT_EXCLUDES = ["node_modules", ".git", "out", "dist", "release"];
const CONFIG_REL = ".devlauncher/config.json";
const TRIGGER_REL = ".devlauncher/trigger.json";
/** Skip a re-copy when local size matches and mtime is within this window. */
const MTIME_TOLERANCE_MS = 2000;

interface TargetConfig {
	/** Shell command to run (from the synced repo). */
	command: string;
	/** Display name; defaults to the target key. */
	label?: string;
	/** Directory to run from, relative to the repo root; defaults to ".". */
	cwd?: string;
}

interface LauncherConfig {
	/** Subdirectory name under ~/.devlauncher-mirrors/; defaults to the repo folder name. */
	mirrorName?: string;
	/** Command run once in the mirror after the first sync (e.g. "pnpm install"). */
	install?: string;
	/** Path segments to skip when mirroring (plain names or `*` globs). */
	excludes?: string[];
	targets: Record<string, TargetConfig>;
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
let config: LauncherConfig | undefined;
let configError: string | undefined;
let busyText: string | undefined;
let lastTriggerNonce: number | undefined;
let watchers: vscode.Disposable[] = [];
let syncWatcher: vscode.FileSystemWatcher | undefined;
const running = new Map<string, ChildProcess>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	extensionUri = context.extensionUri;
	output = vscode.window.createOutputChannel("Remote Dev Launcher");
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusItem.command = "remoteDevLauncher.menu";

	workspace = resolveWorkspace();
	await loadConfig();
	updateStatus();
	statusItem.show();

	context.subscriptions.push(
		output,
		statusItem,
		vscode.commands.registerCommand("remoteDevLauncher.menu", showMenu),
		vscode.commands.registerCommand("remoteDevLauncher.init", initProject),
		vscode.workspace.onDidChangeWorkspaceFolders(async () => {
			workspace = resolveWorkspace();
			await loadConfig();
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

async function loadConfig(): Promise<void> {
	config = undefined;
	configError = undefined;
	if (!workspace) return;

	const uri = vscode.Uri.joinPath(workspace.folder.uri, CONFIG_REL);
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(uri);
	} catch {
		// No config file — the project just is not initialized yet. Not an error.
		return;
	}
	try {
		const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as LauncherConfig;
		if (!parsed.targets || typeof parsed.targets !== "object" || Object.keys(parsed.targets).length === 0) {
			configError = `${CONFIG_REL} defines no "targets".`;
			return;
		}
		config = parsed;
	} catch (err) {
		configError = `${CONFIG_REL} is not valid JSON: ${(err as Error).message}`;
	}
}

function registerWatchers(): void {
	for (const w of watchers) w.dispose();
	watchers = [];
	if (!workspace) return;

	const triggerWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(workspace.folder, TRIGGER_REL)
	);
	triggerWatcher.onDidChange(handleTrigger);
	triggerWatcher.onDidCreate(handleTrigger);

	const configWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(workspace.folder, CONFIG_REL)
	);
	const reload = async (): Promise<void> => {
		await loadConfig();
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
		output.appendLine(`[devlauncher] ignored unreadable trigger: ${(err as Error).message}`);
		return;
	}
	if (!data.target) return;
	if (typeof data.nonce === "number" && data.nonce === lastTriggerNonce) return;
	lastTriggerNonce = typeof data.nonce === "number" ? data.nonce : undefined;
	output.appendLine(`[devlauncher] remote trigger -> ${JSON.stringify(data.target)}`);
	await launchTarget(data.target);
}

/**
 * Base directory where remote workspaces are mirrored on the local machine.
 *
 * Read fresh from the `remoteDevLauncher.clonePath` setting on every call, so a
 * change in VSCode's settings UI takes effect on the next launch with no reload.
 * The workspace folder URI is passed so VSCode resolves the value with the
 * normal precedence — Workspace settings override User/global settings.
 */
function cloneRoot(): string {
	const setting = vscode.workspace
		.getConfiguration("remoteDevLauncher", workspace?.folder.uri)
		.get<string>("clonePath", "")
		.trim();
	if (!setting) return join(homedir(), ".devlauncher-mirrors");
	if (setting === "~") return homedir();
	if (setting.startsWith("~/") || setting.startsWith("~\\")) return join(homedir(), setting.slice(2));
	return setting;
}

function mirrorDir(): string {
	const name = config?.mirrorName?.trim() || basename(workspace?.repoPath ?? "") || "devmirror";
	return join(cloneRoot(), name);
}

function isExcluded(segment: string): boolean {
	for (const pattern of config?.excludes ?? DEFAULT_EXCLUDES) {
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
	output.appendLine(`[devlauncher] mirror ready — ${copied} file(s) updated, ${removed} removed`);
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
		output.appendLine(`[devlauncher] sync skipped ${rel}: ${(err as Error).message}`);
	}
}

function streamProcess(child: ChildProcess, name: string, resolve: (ok: boolean) => void): void {
	child.stdout?.on("data", (d: Buffer) => output.append(d.toString()));
	child.stderr?.on("data", (d: Buffer) => output.append(d.toString()));
	child.on("error", (err) => {
		output.appendLine(`[devlauncher] ${name} failed to start: ${err.message}`);
		resolve(false);
	});
	child.on("exit", (code) => resolve(code === 0));
}

function runShell(commandLine: string, cwd: string): Promise<boolean> {
	return new Promise((resolve) => streamProcess(spawn(commandLine, { cwd, shell: true }), commandLine, resolve));
}

async function launchTarget(name: string): Promise<void> {
	if (!workspace) return error("open a workspace folder (local or over SSH) first.");
	if (configError) return error(configError);
	if (!config) return error(`no ${CONFIG_REL} — run "Remote Dev Launcher: Initialize Project".`);
	if (busyText) return void info("the launcher is busy — try again in a moment.");

	// Capture into locals so narrowing survives the `await`s below.
	const ws = workspace;
	const cfg = config;

	const target = cfg.targets[name];
	if (!target) return error(`no target ${JSON.stringify(name)} in ${CONFIG_REL}.`);
	if (running.has(name)) {
		output.show(true);
		return void info(`target ${JSON.stringify(name)} is already running.`);
	}

	output.show(true);
	output.appendLine("");
	output.appendLine(`[devlauncher] launch ${JSON.stringify(name)}`);

	const cwdRel = target.cwd?.trim() || ".";
	let runCwd: string;

	if (ws.remote === null) {
		runCwd = join(ws.repoPath, cwdRel);
		output.appendLine(`[devlauncher] local repo: ${runCwd}`);
	} else {
		const mirror = mirrorDir();
		runCwd = join(mirror, cwdRel);
		// Cold start: full sync + install. Warm (another target already running):
		// the sync watcher keeps the mirror current, so skip straight to launch.
		if (running.size === 0) {
			await mkdir(mirror, { recursive: true });
			output.appendLine(`[devlauncher] remote: ${ws.remote}:${ws.repoPath}`);
			output.appendLine(`[devlauncher] mirror: ${mirror}`);

			setBusy("syncing");
			try {
				await syncAll(ws, mirror);
			} catch (err) {
				clearBusy();
				return error(`initial sync failed: ${(err as Error).message}`);
			}
			if (cfg.install) {
				setBusy("installing");
				if (!(await runShell(cfg.install, mirror))) {
					clearBusy();
					return error(`install command failed: ${cfg.install}`);
				}
			}
		}
	}

	setBusy(`launching ${name}`);
	output.appendLine(`[devlauncher] $ ${target.command}  (cwd: ${runCwd})`);
	const child = spawn(target.command, { cwd: runCwd, shell: true });
	child.stdout?.on("data", (d: Buffer) => output.append(d.toString()));
	child.stderr?.on("data", (d: Buffer) => output.append(d.toString()));
	child.on("error", (err) => {
		output.appendLine(`[devlauncher] ${JSON.stringify(name)} failed to start: ${err.message}`);
		running.delete(name);
		onRunningChange();
	});
	child.on("exit", (code) => {
		output.appendLine(`[devlauncher] ${JSON.stringify(name)} exited (code ${code ?? 0})`);
		running.delete(name);
		onRunningChange();
	});

	running.set(name, child);
	ensureSyncWatcher();
	clearBusy();
}

function stopTarget(name: string): void {
	const child = running.get(name);
	if (!child) return;
	output.appendLine(`[devlauncher] stopping ${JSON.stringify(name)}`);
	child.kill();
}

function stopAll(): void {
	for (const name of [...running.keys()]) stopTarget(name);
	stopSyncWatcher();
}

function onRunningChange(): void {
	if (running.size === 0) stopSyncWatcher();
	updateStatus();
}

async function showMenu(): Promise<void> {
	if (!workspace) return error("open a workspace folder (local or over SSH) first.");
	if (configError) return error(configError);
	if (!config) {
		const pick = await vscode.window.showQuickPick(["Initialize .devlauncher/ in this project"], {
			placeHolder: "Remote Dev Launcher is not set up for this project",
		});
		if (pick) await initProject();
		return;
	}

	interface Item extends vscode.QuickPickItem {
		target: string;
		isRunning: boolean;
	}
	const items: Item[] = Object.entries(config.targets).map(([name, t]) => {
		const isRunning = running.has(name);
		return {
			label: `${isRunning ? "$(debug-stop)" : "$(rocket)"} ${t.label ?? name}`,
			description: isRunning ? "running — select to stop" : "select to launch",
			detail: t.command,
			target: name,
			isRunning,
		};
	});
	const chosen = await vscode.window.showQuickPick(items, {
		placeHolder: "Remote Dev Launcher — select a target",
	});
	if (!chosen) return;
	if (chosen.isRunning) stopTarget(chosen.target);
	else await launchTarget(chosen.target);
}

async function initProject(): Promise<void> {
	if (!workspace) return error("open a workspace folder first.");

	const written: string[] = [];
	written.push(...(await copyResourceIfMissing("config.template.json", CONFIG_REL)));
	written.push(...(await copyResourceIfMissing("trigger.mjs", ".devlauncher/trigger.mjs")));

	await loadConfig();
	updateStatus();
	registerWatchers();

	if (written.length > 0) {
		info(
			`wrote ${written.join(", ")}. Edit ${CONFIG_REL} to define your targets, ` +
				`then add ".devlauncher/trigger.json" to .gitignore.`
		);
	} else {
		info(".devlauncher/ is already initialized for this project.");
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
		statusItem.text = `$(sync~spin) Dev Launcher: ${busyText}`;
		statusItem.tooltip = busyText;
	} else if (running.size > 0) {
		statusItem.text = `$(debug-stop) Dev Launcher (${running.size})`;
		statusItem.tooltip = `${running.size} target(s) running locally — click to manage`;
	} else {
		statusItem.text = "$(rocket) Dev Launch";
		statusItem.tooltip = config
			? "Click to launch a dev target on this machine"
			: (configError ?? "No .devlauncher/config.json — click to initialize");
	}
}

function error(message: string): void {
	if (output) output.appendLine(`[devlauncher] ${message}`);
	void vscode.window.showErrorMessage(`Remote Dev Launcher: ${message}`);
}

function info(message: string): void {
	void vscode.window.showInformationMessage(`Remote Dev Launcher: ${message}`);
}
