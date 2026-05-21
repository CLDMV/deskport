# Changelog

All notable changes to the DeskPort extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
