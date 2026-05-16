# Deskport Example — Electron App

A minimal Electron app for testing the **Remote Dev Launcher** extension. It
opens one window and shows when it loaded.

## Use it as a test target

This folder ships a `.devlauncher/config.json` with a single `app` target
(`pnpm dev`), so the extension is ready to drive it.

1. Open **this folder** (`examples/electron-app/`) as a VSCode workspace —
   locally, or on a remote host over Remote-SSH.
2. Make sure the Remote Dev Launcher extension is installed on your local
   machine (`pnpm run install-local` from the repo root, run on that machine).
3. Click **🚀 Dev Launch** in the status bar and pick **Example Electron App**.

When the workspace is remote, the extension mirrors this folder into the local
clone directory (see the `remoteDevLauncher.clonePath` setting) and runs
`pnpm dev` there. When the workspace is local, it runs `pnpm dev` in place.

## Run it directly (no extension)

```bash
pnpm install
pnpm dev
```
