# DeskPort

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

Build the `.vsix` from the repo root (this can run on the remote — it is just
a compile + zip):

```bash
pnpm install
pnpm run package          # produces deskport.vsix
```

Then in VSCode: Command Palette → **Extensions: Install from VSIX…** → pick
`deskport.vsix`. Because the extension is `ui`-kind, VSCode installs it on your
local machine, so it serves every project you open.

On your local machine you can do both steps at once with
`pnpm run install-local`, which builds the `.vsix` and installs it via the
`code` CLI.

## Set up a project

Run **DeskPort: Initialize Project** from the Command Palette. It
writes two files under `.deskport/`:

- `config.json` — defines your targets. Edit it:

  ```json
  {
  	"install": "pnpm install",
  	"excludes": ["node_modules", ".git", "out", "dist", "release"],
  	"targets": {
  		"app": { "label": "My Electron App", "command": "pnpm dev", "cwd": "." },
  		"admin": { "label": "Admin Window", "command": "pnpm --filter admin dev" }
  	}
  }
  ```

  Each target is a shell `command` run from `cwd` (relative to this config's
  folder). `install` runs once, in this config's folder, after the first sync.
  When you launch a target, DeskPort mirrors **only that config's folder** —
  not the whole workspace — into `~/.deskport-mirrors/<ssh-host>/<remote-path>/`,
  so opening a parent that contains many unrelated projects is safe.

- `trigger.mjs` — lets the remote start a target (see below).

Add `.deskport/trigger.json` to your `.gitignore` — it is runtime state.

## Launch a target

**From the status bar** — click **🚀 DeskPort** and pick a target. Running
targets show a stop icon; pick one to stop it. Multiple targets run at once.

**From the remote** — `trigger.mjs` writes a trigger file the extension watches
(VSCode bridges the file watcher across the SSH connection). Wire it into your
package scripts:

```json
"scripts": {
	"launchLocal1": "node .deskport/trigger.mjs app",
	"launchLocal2": "node .deskport/trigger.mjs admin"
}
```

Now `npm run launchLocal1` on the remote → the local extension mirrors the repo
and launches that target on your machine. While a target runs, a file watcher
copies each remote edit so it hot-reloads.

## Settings

The extension reads its settings from VSCode itself — there is no separate UI.
Open **Settings** and search for "DeskPort":

- **`deskport.clonePath`** — base directory on the **local machine** where
  remote workspaces are mirrored. Each launch lands under
  `<clonePath>/<ssh-host>/<absolute-remote-path>/`, so the same remote folder
  always maps to the same local path regardless of which parent directory you
  opened in VSCode. Empty (the default) means `~/.deskport-mirrors`; a leading
  `~` expands to your home directory.

Because it is a local path, set it once in **User** settings to apply
everywhere, or override it per project in **Workspace** settings — VSCode
resolves the value with the usual Workspace-over-User precedence, and the
extension picks it up automatically on the next launch.

## Try it — example app

[`examples/electron-app/`](examples/electron-app/) is a minimal Electron app
wired with a `.deskport/config.json`. Open that folder as a workspace
(locally or over Remote-SSH), then launch the **Example Electron App** target
from the status bar to verify your setup end to end.

## Requirements

Local machine: only what your target commands need (`node`, `pnpm`, …). Syncing
needs no `ssh` or `rsync` — it reuses VSCode's connection. The remote needs Node
≥ 20.11 to run `trigger.mjs`.
