# Changelog

All notable changes to the DeskPort extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.7.0]: https://github.com/CLDMV/deskport/releases/tag/v0.7.0
