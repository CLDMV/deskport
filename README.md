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

## pnpm monorepos

If a target's package belongs to a pnpm workspace, scoping the sync to that one package folder isn't enough — pnpm resolves `workspace:*` dependencies at the **workspace root** (`pnpm-workspace.yaml` + the lockfile + a single hoisted store), so installing inside an isolated package can't link its sibling packages.

DeskPort handles this automatically. Before launching, it walks **up** from the target's package looking for a `pnpm-workspace.yaml` (the same way pnpm finds its root). When it finds one, it treats that directory as the workspace root and mirrors:

- the root manifests — `pnpm-workspace.yaml`, `pnpm-lock.yaml`, the root `package.json`, `.npmrc`, `.pnpmfile.cjs`;
- the target package itself;
- every `workspace:*` dependency package the target needs, resolved transitively from each `package.json`.

It then runs `install` from that root, so pnpm builds the dependency links correctly. A bare `pnpm install` is automatically scoped to the launched package and its dependencies (`pnpm install --filter "<name>..."`); a custom `install` command runs as written. The target then runs from its own package folder, with `node_modules` linked as pnpm intends.

The discovered root may sit **above** the folder you opened in VSCode, so opening a single package of a larger monorepo works — DeskPort reaches up to the real root regardless. How far up it looks is controlled by `deskport.workspaceMaxHeight` (default 5; see [Settings](#settings)); a per-package `"workspaceMaxHeight"` in `config.json` overrides it, and `0` disables the walk. If no `pnpm-workspace.yaml` is found within the cap, DeskPort just syncs the target's own folder as usual.

If the resolver misses a dependency (an unusual layout, a catalog reference, a runtime-only path import), list the extra package folder(s) under `include` — they're mirrored alongside the auto-resolved set.

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
- **`deskport.workspaceMaxHeight`** — how many directory levels DeskPort walks
  up from a target's package looking for a `pnpm-workspace.yaml` (default `5`).
  See [pnpm monorepos](#pnpm-monorepos). Set to `0` to disable the walk-up; a
  per-package `"workspaceMaxHeight"` in `.deskport/config.json` overrides it.

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
