# DeskPort — Roadmap / Future Features

## Controlled terminal mode

Targets currently launch in a **real interactive VSCode terminal** via
`terminal.sendText()` — full color, scrollback, and the user can type into it
and press Ctrl+C. One terminal is kept per target and reused across launches;
a new one is created if it was closed.

The trade-off of this "fast" approach: DeskPort tracks the *terminal*, not the
*process* running inside it. It knows a terminal exists, not whether the
program is still running or how it exited. So today it cannot:

- show accurate running / stopped state in the status bar and hover menu
- detect a crash and surface the error as a notification (the terminal shows
  the error live instead)
- offer a precise "stop the process" — only "close terminal"

**Revisit:** add a more controlled launch mode that tracks the process while
still showing a terminal. Options:

- VSCode **shell integration API** (`onDidStartTerminalShellExecution` /
  `onDidEndTerminalShellExecution`) — runs a command in a real terminal and
  reports its exit code. Needs a newer `engines.vscode` and shell integration
  to be active for the user's shell.
- A custom **`Pseudoterminal`** that DeskPort feeds from a `child_process` it
  owns — full process control (exit codes, kill), output rendered in a
  terminal, but not an interactive shell.

That would restore exit-code / crash detection and accurate status while
keeping the program's output visible.

### Related ideas to revisit alongside this

- Richer status updates per target (starting / running / exited / crashed)
- Per-target run history and a restart action
- A dockable DeskPort view (tree of targets with inline run/stop)

## Status bar hover/click popup

Copilot Chat's anchored status bar popup uses `window.createChatStatusItem()`
— confirmed by inspecting the builtin `GitHub.copilot-chat` extension: it lists
`chatStatusItem` in `enabledApiProposals` and calls `createChatStatusItem` in
its code.

`chatStatusItem` is a **proposed API** — `vsce package` accepts it, but at
runtime VSCode only grants proposed APIs to builtin / allowlisted extensions
or when launched with `--enable-proposed-api <publisher.ext>`.

**Tested, then reverted (v0.5.0 → v0.5.1).** DeskPort shipped an experimental
`createChatStatusItem` behind the proposed API. With the launch flag it *did*
work — but every `createChatStatusItem` entry aggregates into the single
**shared Chat status popup**, the same one Copilot uses. DeskPort appeared
*inside Copilot's popup*, not in a popup of its own. So this API is not a path
to a separate DeskPort popup, and it was removed.

Conclusion: a regular extension cannot produce a dedicated, pinnable status
bar popup. DeskPort uses a trusted `MarkdownString` `tooltip` (a hover card
above the status bar item). That tooltip cannot be pinned by a click —
click-to-pin is a property of the core Chat status popup only.

**Revisit** only if VSCode adds a stable, general status-bar popup API.
