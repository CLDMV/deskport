# Changelog

All notable changes to the DeskPort extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.5] - 2026-05-23

### Fixed

- **The pnpm-workspace walk-up no longer hijacks self-contained packages.** Since 0.9.0 DeskPort walked up from every launched target looking for a `pnpm-workspace.yaml` and, when found, switched the install to run from that root. That's correct for a package whose deps include `workspace:*` siblings, but it broke any package whose `.deskport/config.json` declared a self-contained install command — `install: "npm install"` got run at the workspace-root mirror (where it has no deps to install), and the package's own dependencies were silently skipped. The walk-up now only fires when **both** gates hold: (1) the package's install command is pnpm-prefixed, and (2) the target's own `package.json` declares at least one `workspace:*` dep across `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies`. Either gate failing → install runs at the package folder, the same way it did pre-0.9.0.
- **Stopping a target on Windows now reports "stopped" instead of "failed (exit 1)".** Windows has no signals, so `taskkill /T /F` exits the shell with `code: 1, signal: null` — the same shape `child.on("exit")` saw for a real crash. A `stopping` flag is now set on the terminal whenever DeskPort initiates a stop (stop button, Ctrl+C); the exit handler synthesizes a `SIGTERM` signal in that case so the status badge reflects user intent. POSIX behavior is unchanged.

## [0.9.4] - 2026-05-22

### Fixed

- **`pnpm install` no longer aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.** DeskPort's install step runs without a TTY (it's spawned by the extension, not from a terminal), and pnpm refuses to remove an existing `node_modules` directory in that case unless told it's running non-interactively. The `runShell` helper that drives install/setup commands now exports `CI=true` for its child, which is the standard signal package managers expect. The launched target's own environment is unchanged — `CI` is only set for the install/setup shell.

### Changed

- **Workspace discovery is now ripgrep-fast.** The scan for `.deskport/config.json` files now uses VSCode's search service (`workspace.findFiles`) instead of a recursive `workspace.fs.readDirectory` walk. The old walk paid one network round-trip per directory and could take minutes on a large monorepo opened over Remote-SSH; the indexer-backed search runs on the remote side and typically returns in well under a second. Concurrent scans (activation + watcher reloads + manual Refresh) now share one in-flight pass and automatically re-run if a config-touching event lands during the scan.
- **Activation no longer blocks on the scan.** The initial discovery runs fire-and-forget so the extension is "active" immediately. The sidebar shows a pulsing **Scanning workspace for .deskport/config.json…** message until the first scan completes, and the footer carries a small `· scanning…` indicator any time a scan is in flight (including watcher-triggered refreshes after the first one). Previously the sidebar appeared empty until the slow scan happened to finish — usually only after clicking the tab triggered something to surface.
- The output channel logs `[deskport] scanning workspace…` and `[deskport] scan complete in <ms> — <N> config(s)` for visibility into when and how long scans take.

## [0.9.3] - 2026-05-22

### Changed

- The sidebar action button now tracks the active launch phase — it reads **Syncing…** while the cold sync is running, **Installing…** during the install step, and **Launching…** before/around the spawn. Previously it stuck at a single "Launching…" label for the whole pre-spawn handoff. The status row text mirrors the phase too.
- Discovery of `.deskport/config.json` files now also reacts to VSCode file-operation events (`onDidCreateFiles` / `onDidDeleteFiles` / `onDidRenameFiles`) in addition to the existing filesystem watcher on `**/.deskport/config.json`. Creating a `.deskport` directory (or renaming a folder into/out of one) from the Explorer — or from another extension calling `workspace.fs` — now triggers an immediate re-scan instead of waiting for a manual **Refresh Targets**.

## [0.9.2] - 2026-05-22

### Changed

- The sidebar Run button immediately switches to a disabled "Launching…" label (with a pulsing blue status dot) as soon as you click it, and stays there through sync/install until the process spawns and the button becomes "Stop". Previously the button kept saying "Run" through the whole pre-spawn handoff, so the only feedback was the progress toast.

## [0.9.1] - 2026-05-22

### Fixed

- **Stop now actually kills the launched app.** Targets run under `shell: true`, so the direct child is `sh -c <cmd>` (or `cmd /c` on Windows) and the real program (e.g. an Electron app launched via `npm run`) is the shell's grandchild. Previously, clicking Stop SIGTERM'd only the shell — the shell exited, but the GUI app got reparented to init and kept running until you closed it by hand. DeskPort now spawns the shell in its own process group on POSIX (`detached: true`) and signals the whole group, so descendants are stopped too. On Windows, `taskkill /T /F` walks the child tree. The same applies to the relaunch path, Ctrl+C in the target terminal, and terminal-close.

## [0.9.0] - 2026-05-22

### Added

- **pnpm workspace support.** Before launching a target, DeskPort now walks up from the target's package looking for a `pnpm-workspace.yaml`. When it finds one within the configured height, it treats that directory as the workspace root: it mirrors the root manifests (`pnpm-workspace.yaml`, `pnpm-lock.yaml`, root `package.json`, `.npmrc`, `.pnpmfile.cjs`), the target package, and the target's `workspace:*` dependency packages (resolved transitively from `package.json`), then runs `install` from that root so pnpm links the workspace dependencies correctly. Previously a scoped sync of a single package folder couldn't establish pnpm linkage, because pnpm resolves `workspace:*` deps at the workspace root. The discovered root may sit **above** the folder you opened in VSCode — so opening one package of a larger monorepo now works.
- **`deskport.workspaceMaxHeight` setting** (default `5`) and a matching per-package `"workspaceMaxHeight"` config field — how many levels to walk up looking for `pnpm-workspace.yaml`. Set to `0` to disable the walk-up. When no workspace file is found within the cap, DeskPort falls back to syncing just the target's own folder, exactly as before.
- A bare `pnpm install` / `pnpm i` is automatically scoped to the target package and its dependencies (`pnpm install --filter "<name>..."`) when run at a discovered workspace root, so a partial member set installs cleanly. A customized `install` command runs verbatim.

### Changed

- The live mirror watcher is now rooted **per synced scope** instead of once over the opened folder, so scopes above the opened folder (a discovered workspace root and its members) are watched too, and unrelated siblings in a large monorepo no longer generate watcher traffic. Watching a path outside the opened folder is best-effort over Remote-SSH; the cold-sync re-run on each launch still reconciles the mirror regardless.

## [0.8.2] - 2026-05-22

### Added

- The status-bar item now opens a scrollable, type-to-filter **QuickPick** of every target (grouped by package) — launch or stop from there. The hover tooltip caps its inline list at 15 targets with a "+N more" link into the panel, so a workspace with many targets stays usable.
- **DeskPort: Refresh Targets** command, wired to a button on the Targets view title bar and to the tooltip.

### Changed

- The status-bar item moved to the right; the panel footer and tooltip now show the extension version.
- `.pnpm` and `.pnpm-store` are skipped by default during sync.

## [0.8.1] - 2026-05-20

### Changed

- **The cold sync is now scoped to the launching target's package folder**
  (the folder of its `.deskport/config.json`) instead of the whole workspace.
  This is the change that makes opening a parent of many repos usable: a
  launch only pulls down the package it actually needs.
- **Local mirror layout is now derived from the resolved SSH hostname and
  remote absolute path**, as `<clonePath>/<hostname>/<abs-remote-path>/`. The
  hostname segment comes from `ssh -G <alias>`, so two different
  `~/.ssh/config` aliases that point at the same machine share one mirror
  instead of producing two. The same remote folder always maps to the same
  local path regardless of which parent directory the user happened to open in
  VSCode, and nested scopes share files instead of duplicating them. **You can
  delete any old mirrors under `~/.deskport-mirrors/` that don't match the
  new layout.** If `ssh -G` isn't reachable on the local machine, DeskPort
  falls back to the VSCode alias (the previous behavior).
- The cold sync now scans the remote tree up front, then drives a
  **byte-weighted** percent-progress bar with `N/M files` status as each file
  copies, so a workspace dominated by a few big files reports honest progress
  instead of jumping in even file-count increments.
- The launch notification is now cancellable; cancelling during sync (or
  between sync and install) bails out cleanly and lets the next launch retry.

### Added

- **`.gitignore` is now honored** when scanning a scope's remote tree. DeskPort
  reads the `.gitignore` at the scope's root folder (on the remote) and skips
  matching files. Negation patterns (`!keep.me`) are not supported yet — use
  `includeFiles` to force-include something instead. Toggle off per package
  with `"respectGitignore": false`.
- **Default file-extension skip list** — DeskPort now skips `*.md`,
  `*.markdown`, `*.txt`, `*.log`, `*.test.*`, `*.spec.*`, `*.lock`, `LICENSE*`,
  and `CHANGELOG*` automatically (none of them affect runtime). Default
  directory skips also expanded to include `__tests__`, `docs`, `examples`,
  and `screenshots`.
- **New per-config fields:**
  - `excludeFiles: string[]` — extra filename/path globs to skip (additive).
  - `includeFiles: string[]` — globs that **force-include** a file even when
    the defaults or `.gitignore` would skip it (e.g. `"README.md"` for an app
    that loads its readme at runtime).
  - `include: string[]` — extra paths (relative to this config's folder) to
    mirror alongside it. Use it when a package needs sibling deps from a
    cross-package monorepo, e.g. `["../shared-lib"]`. Each extra lands at its
    natural remote-absolute mirror path, so the package's own relative
    imports (`import "../shared-lib"`) keep working.
  - `respectGitignore: boolean` (default `true`).
- The existing `excludes` array is now **additive** with the built-in
  defaults rather than replacing them, so a one-entry list can't accidentally
  un-ignore `node_modules`.

### Changed

- **Cold sync now runs on every launch** instead of being skipped after the
  first sync of a session. The per-file stat-then-skip optimization makes a
  no-op revalidation cheap, and it's the only thing that catches changes
  the live `FileSystemWatcher` misses — notably atomic renames (`sed -i`,
  many editors) where the new inode often doesn't fire a usable event over
  the Remote-SSH bridge. The mirror stops going stale.

### Removed

- The `mirrorName` field in `.deskport/config.json` is no longer used — the
  local mirror path is now derived from the remote path automatically. The
  field will be silently ignored if present, and can be removed.

### Fixed

- A failure on a single remote file no longer aborts the whole sync — the
  error is logged to the DeskPort output channel and the sync continues.
- Symlinks in the remote tree are skipped (and directory revisits guarded),
  preventing the recursive walk from looping on a directory cycle.
- Unexpected sync errors now log their stack to the output channel, making
  hard failures diagnosable instead of just a one-line toast.

## [0.7.1] - 2026-05-17

### Changed

- Marketplace metadata only: added search keywords, `author` / `funding` /
  `sponsor` fields, and an explicit `Apache-2.0` license identifier. No
  functional changes.

## [0.7.0] - 2026-05-17

First public release.

### Added

- Mirror an SSH-remote workspace to the local machine and launch configured
  dev targets there — for Electron and other GUI apps that must run where the
  display is.
- `.deskport/config.json` project configuration, including **nested configs**
  so monorepos can declare a target per package (lazy install per package).
- **Targets** sidebar in its own activity-bar container, rendered as a webview
  of target cards styled after the Extensions view. Each target shows live run
  status, including failures, and supports a custom icon via base64 or file
  path (falling back to the DeskPort rocket).
- Targets run in a local pseudoterminal that DeskPort feeds from a
  locally-spawned process — one reusable terminal per target — so output is
  visible even when the workspace is opened over Remote-SSH.
- `deskport.clonePath` setting (window scope) to choose where remote
  workspaces are mirrored locally; visible in User, Workspace, and Remote
  settings.
- `DeskPort: Initialize Project` and `DeskPort: Targets…` commands.
- Example Electron app under `examples/` for testing a launch end to end.
- Extension icon, marketplace metadata, and publish / local-install scripts.

### Fixed

- Activation no longer stalls on Remote-SSH workspaces (the file scan now walks
  the tree directly instead of relying on `findFiles`).
- `ELECTRON_RUN_AS_NODE` is stripped from the child environment, so launched
  Electron apps start correctly instead of crashing on `app.whenReady`.
- Launch errors now surface the captured process output in the notification.
- `out/` packaging is restricted to compiled JavaScript so stray files cannot
  leak into the `.vsix`.

[0.8.1]: https://github.com/CLDMV/deskport/releases/tag/v0.8.1
[0.7.1]: https://github.com/CLDMV/deskport/releases/tag/v0.7.1
[0.7.0]: https://github.com/CLDMV/deskport/releases/tag/v0.7.0
