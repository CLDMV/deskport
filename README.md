# Remote Dev Launcher

A VSCode extension that **launches dev targets on your local machine** even when
the repo lives on a remote SSH host. Built for Electron and other GUI apps that
must run where the display is, but works for any command.

## Why it exists

With VSCode Remote-SSH the integrated terminal runs on the _remote_ host, so it
cannot open a GUI window locally. This extension declares
`extensionKind: ["ui"]`, which makes VSCode run it in the **local** extension
host. From there it can mirror the repo to your machine and spawn real local
processes — while being driven from the remote VSCode window.

Syncing uses VSCode's own filesystem bridge (`vscode.workspace.fs`), reusing the
connection Remote-SSH already holds — so **no `ssh` or `rsync` is needed
locally**, and it works the same on Windows, macOS, and Linux. A
`FileSystemWatcher` keeps the mirror live: each remote edit copies a single
file, so hot-reload is event-driven.

## Install (once, per local machine)

Build the `.vsix` (this can run on the remote — it is just a compile + zip):

```bash
cd tools/vscode-extension
pnpm install --ignore-workspace
pnpm run package          # produces remote-dev-launcher.vsix
```

Then in VSCode: Command Palette → **Extensions: Install from VSIX…** → pick
`remote-dev-launcher.vsix`. Because the extension is `ui`-kind, VSCode installs
it on your local machine, so it serves every project you open.

## Set up a project

Run **Remote Dev Launcher: Initialize Project** from the Command Palette. It
writes two files under `.devlauncher/`:

- `config.json` — defines your targets. Edit it:

  ```json
  {
  	"mirrorName": "my-app",
  	"install": "pnpm install",
  	"excludes": ["node_modules", ".git", "out", "dist", "release"],
  	"targets": {
  		"app": { "label": "My Electron App", "command": "pnpm dev", "cwd": "." },
  		"admin": { "label": "Admin Window", "command": "pnpm --filter admin dev" }
  	}
  }
  ```

  Each target is a shell `command` run from `cwd` (relative to the repo root).
  `install` runs once after the first sync. `mirrorName` is the local mirror
  folder under `~/.devlauncher-mirrors/`.

- `trigger.mjs` — lets the remote start a target (see below).

Add `.devlauncher/trigger.json` to your `.gitignore` — it is runtime state.

## Launch a target

**From the status bar** — click **🚀 Dev Launch** and pick a target. Running
targets show a stop icon; pick one to stop it. Multiple targets run at once.

**From the remote** — `trigger.mjs` writes a trigger file the extension watches
(VSCode bridges the file watcher across the SSH connection). Wire it into your
package scripts:

```json
"scripts": {
	"launchLocal1": "node .devlauncher/trigger.mjs app",
	"launchLocal2": "node .devlauncher/trigger.mjs admin"
}
```

Now `npm run launchLocal1` on the remote → the local extension mirrors the repo
and launches that target on your machine. While a target runs, a file watcher
copies each remote edit so it hot-reloads.

## Requirements

Local machine: only what your target commands need (`node`, `pnpm`, …). Syncing
needs no `ssh` or `rsync` — it reuses VSCode's connection. The remote needs Node
≥ 20.11 to run `trigger.mjs`.
