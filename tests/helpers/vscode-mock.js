"use strict";

/**
 * Minimal in-process `vscode` API double — just the surface DeskPort's sync walk
 * touches (`Uri`, `FileType`, `workspace.fs`, a no-op output channel).
 *
 * `install()` patches `Module._load` so a later `require("vscode")` (the form
 * the compiled extension uses) resolves here instead of failing — there is no
 * real `vscode` module outside the extension host. Call it BEFORE requiring
 * out/extension.js. `setFs()` swaps the backing filesystem per test; the
 * extension reads `vscode.workspace.fs` fresh on every call, so a getter keeps
 * the swap live without re-requiring the module.
 */

/** Real VSCode `FileType` bit values. */
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

/** A path-only stand-in for `vscode.Uri` (enough for joinPath / toString / .path). */
class Uri {
	constructor(path, scheme = "remote") {
		this.path = path;
		this.scheme = scheme;
	}
	toString() {
		return `${this.scheme}://${this.path}`;
	}
	static file(p) {
		return new Uri(p, "file");
	}
	static joinPath(base, ...segs) {
		const head = base.path.replace(/\/+$/, "");
		const tail = segs.filter((s) => s != null && s !== "").join("/");
		const joined = tail === "" ? head : head === "" ? tail : `${head}/${tail}`;
		return new Uri(joined, base.scheme);
	}
}

/**
 * Build an in-memory remote filesystem from a flat `{ "rel/path": content }`
 * map. Directories are implied by path prefixes. `symlinks` is a Set of paths
 * to report as symbolic links. Tracks read counts so tests can assert that a
 * `.gitignore` is read once per directory that has one, and that ignored
 * directories are never descended into.
 */
function makeFs(files, symlinks = new Set()) {
	let readFile = 0;
	let readDir = 0;
	let stat = 0;
	const norm = (p) => p.replace(/^\/+/, "").replace(/\/+$/, "");
	const paths = Object.keys(files);

	const isFile = (p) => Object.prototype.hasOwnProperty.call(files, norm(p));
	const isDir = (p) => {
		const d = norm(p);
		if (d === "") return true;
		const prefix = `${d}/`;
		return paths.some((f) => f.startsWith(prefix));
	};
	const childrenOf = (dirPath) => {
		const d = norm(dirPath);
		const prefix = d === "" ? "" : `${d}/`;
		const seen = new Map();
		for (const f of paths) {
			if (prefix !== "" && !f.startsWith(prefix)) continue;
			const rest = f.slice(prefix.length);
			if (rest === "") continue;
			const slash = rest.indexOf("/");
			if (slash === -1) {
				seen.set(rest, symlinks.has(f) ? FileType.SymbolicLink : FileType.File);
			} else if (!seen.has(rest.slice(0, slash))) {
				seen.set(rest.slice(0, slash), FileType.Directory);
			}
		}
		return [...seen.entries()];
	};

	const fs = {
		async readDirectory(uri) {
			readDir++;
			if (!isDir(uri.path)) throw new Error(`ENOENT (readDirectory): ${uri.path}`);
			return childrenOf(uri.path);
		},
		async readFile(uri) {
			readFile++;
			const p = norm(uri.path);
			if (!isFile(p)) throw new Error(`ENOENT (readFile): ${p}`);
			return Buffer.from(files[p], "utf8");
		},
		async stat(uri) {
			stat++;
			const p = norm(uri.path);
			if (isFile(p)) return { type: FileType.File, size: Buffer.byteLength(files[p], "utf8"), mtime: 1000 };
			if (isDir(p)) return { type: FileType.Directory, size: 0, mtime: 1000 };
			throw new Error(`ENOENT (stat): ${p}`);
		}
	};
	return {
		fs,
		counts: () => ({ readFile, readDir, stat }),
		reset: () => {
			readFile = readDir = stat = 0;
		}
	};
}

let currentFs = null;
const vscode = {
	FileType,
	Uri,
	workspace: {
		get fs() {
			return currentFs;
		}
	},
	window: {
		createOutputChannel: () => ({ appendLine() {}, dispose() {} })
	}
};

/** Point `vscode.workspace.fs` at a filesystem from {@link makeFs}. */
function setFs(impl) {
	currentFs = impl;
}

/** Patch the module loader so `require("vscode")` returns this double. Idempotent. */
function install() {
	const Module = require("node:module");
	if (Module.__deskportVscodeMock) return;
	const original = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === "vscode") return vscode;
		return original.call(this, request, parent, isMain);
	};
	Module.__deskportVscodeMock = true;
}

module.exports = { FileType, Uri, vscode, makeFs, setFs, install };
