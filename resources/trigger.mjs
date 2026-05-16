#!/usr/bin/env node
/**
 * DeskPort — trigger.
 *
 * Run this ON THE REMOTE host (typically from an npm/pnpm script). It writes a
 * trigger file that the local "DeskPort" VSCode extension watches.
 * The extension then syncs this repo to your local machine and launches the
 * named target there — giving a "remote command -> local launch" flow.
 *
 *   node .deskport/trigger.mjs <target-name>
 *
 * Example package.json scripts:
 *   "launchLocal1": "node .deskport/trigger.mjs app",
 *   "launchLocal2": "node .deskport/trigger.mjs admin"
 *
 * The target names must match keys under "targets" in .deskport/config.json.
 * Requires Node >= 20.11 (for import.meta.dirname).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];
if (!target) {
	process.stderr.write("trigger: usage - node .deskport/trigger.mjs <target-name>\n");
	process.exit(1);
}

writeFileSync(join(import.meta.dirname, "trigger.json"), JSON.stringify({ target, nonce: Date.now() }) + "\n");

process.stdout.write(
	"DeskPort: requested target " +
		JSON.stringify(target) +
		". The local VSCode extension will sync this repo and launch it on your machine.\n"
);
