"use strict";

/**
 * Integration tests for the live sync walk in src/extension.ts.
 *
 * These load the COMPILED extension (out/extension.js) under a fake `vscode`
 * (tests/helpers/vscode-mock.js) and drive the real `scanRemote` (cold sync),
 * `mirrorSubtree` (incremental copy), and `chainForPath` (live watcher) against
 * an in-memory remote tree. So the per-directory `.gitignore` reading, the
 * chain threading, the rule cache, and the ignore decisions are all exercised
 * end-to-end — not just the pure matcher. The walk internals are reached via the
 * `__test` handle the extension exports for this purpose.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readdir, rm } = require("node:fs/promises");
const path = require("node:path");

const mock = require("./helpers/vscode-mock.js");
mock.install(); // must precede the extension require so its `require("vscode")` resolves here
const { __test } = require("../out/extension.js");
const { decideIgnored } = require("../out/gitignore.js");
__test.setOutput({ appendLine() {} });

const { Uri, makeFs, setFs } = mock;
const FILTER_ON = { respectGitignore: true, excludeFiles: [], includeFiles: [] };
const NO_TOKEN = { isCancellationRequested: false };

/** The plan's motivating fixture: a root rule, a nested rule, and a deeper re-include. */
const TREE = {
	".gitignore": "*.log\n",
	"keep.txt": "hello",
	"a/.gitignore": "tmp/\n",
	"a/tmp/junk.txt": "junk", // ignored by a/.gitignore `tmp/`
	"a/b/.gitignore": "!keep.log\n",
	"a/b/keep.log": "keep", // re-included under root `*.log`
	"a/b/drop.log": "drop", // ignored by root `*.log`
	"a/note.log": "note", // ignored by root `*.log`
	"b/tmp/data.txt": "data" // kept: the `tmp/` rule is scoped to a/, not b/
};

/** Run a cold scan over `files`, returning the kept rel-paths (sorted) and the fs read counts. */
async function coldScan(files, { filter = FILTER_ON, excludes = [], symlinks } = {}) {
	const remote = makeFs(files, symlinks);
	setFs(remote.fs);
	__test.gitignoreCache.clear();
	const out = [];
	await __test.scanRemote(new Uri(""), "", out, NO_TOKEN, new Set(), excludes, filter, [], () => {});
	return { kept: out.map((f) => f.rel).sort(), counts: remote.counts(), remote };
}

/** Recursively list files under a local dir, relative to it. */
async function listFilesRel(root, sub = "") {
	const entries = await readdir(path.join(root, sub), { withFileTypes: true });
	const out = [];
	for (const e of entries) {
		const rel = sub ? `${sub}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...(await listFilesRel(root, rel)));
		else out.push(rel);
	}
	return out;
}

// ── cold sync (scanRemote) ───────────────────────────────────────────────────

test("cold walk honors nested .gitignore, negation, and subtree scoping", async () => {
	const { kept, counts } = await coldScan(TREE);
	assert.deepEqual(
		kept,
		[".gitignore", "a/.gitignore", "a/b/.gitignore", "a/b/keep.log", "b/tmp/data.txt", "keep.txt"].sort()
	);
	// a/tmp/junk.txt, a/b/drop.log, and a/note.log are all skipped.
	assert.equal(counts.readFile, 3, "reads .gitignore exactly once per dir that has one (root, a, a/b)");
	assert.equal(counts.readDir, 5, "never descends into the ignored a/tmp (root, a, a/b, b, b/tmp)");
});

test("cold walk with respectGitignore=false mirrors everything and reads no .gitignore", async () => {
	const filter = { respectGitignore: false, excludeFiles: [], includeFiles: [] };
	const { kept, counts } = await coldScan(TREE, { filter });
	assert.deepEqual(kept, Object.keys(TREE).sort());
	assert.equal(counts.readFile, 0);
});

test("cold walk: includeFiles force-includes a path a .gitignore would skip", async () => {
	const filter = { respectGitignore: true, excludeFiles: [], includeFiles: ["drop.log"] };
	const { kept } = await coldScan(TREE, { filter });
	assert.ok(kept.includes("a/b/drop.log"), "drop.log forced back in despite the root *.log rule");
	assert.ok(!kept.includes("a/note.log"), "note.log, not force-included, stays ignored");
});

test("cold walk never follows or copies symlinks", async () => {
	const { kept } = await coldScan({ "real.txt": "x", "link": "ptr" }, { symlinks: new Set(["link"]) });
	assert.deepEqual(kept, ["real.txt"]);
});

// ── rule cache ───────────────────────────────────────────────────────────────

test("cache reuses rules across walks; clear() forces a re-read", async () => {
	const remote = makeFs(TREE);
	setFs(remote.fs);
	__test.gitignoreCache.clear();
	const walk = async () => {
		await __test.scanRemote(new Uri(""), "", [], NO_TOKEN, new Set(), [], FILTER_ON, [], () => {});
	};
	await walk();
	assert.equal(remote.counts().readFile, 3, "first walk reads all three .gitignore files");
	remote.reset();
	await walk();
	assert.equal(remote.counts().readFile, 0, "second walk serves every rule from cache");
	__test.gitignoreCache.clear();
	remote.reset();
	await walk();
	assert.equal(remote.counts().readFile, 3, "after clear(), .gitignore files are re-read");
});

test("a changed .gitignore takes effect once its cache entry is invalidated", async () => {
	const files = { "a/.gitignore": "*.txt\n", "a/keep.txt": "x", "a/keep.md": "y" };
	const remote = makeFs(files);
	setFs(remote.fs);
	__test.gitignoreCache.clear();
	const scan = async () => {
		const out = [];
		await __test.scanRemote(new Uri(""), "", out, NO_TOKEN, new Set(), [], FILTER_ON, [], () => {});
		return out.map((f) => f.rel).sort();
	};
	assert.deepEqual(await scan(), ["a/.gitignore", "a/keep.md"]); // *.txt ignored
	files["a/.gitignore"] = "*.md\n"; // edit the rule
	assert.deepEqual(await scan(), ["a/.gitignore", "a/keep.md"], "stale cached rule still applies");
	__test.gitignoreCache.delete(new Uri("a").toString()); // what onScopeEvent does on a .gitignore change
	assert.deepEqual(await scan(), ["a/.gitignore", "a/keep.txt"], "fresh rule now ignores *.md instead");
});

// ── live watcher (chainForPath) ──────────────────────────────────────────────

test("watcher chainForPath reproduces the cold walk's decision for a single path", async () => {
	const remote = makeFs(TREE);
	setFs(remote.fs);
	__test.gitignoreCache.clear();
	await __test.scanRemote(new Uri(""), "", [], NO_TOKEN, new Set(), [], FILTER_ON, [], () => {}); // warm the cache
	const job = { remoteRoot: new Uri(""), filter: FILTER_ON };
	const cases = [
		["a/b/keep.log", false], // re-included
		["a/b/drop.log", true], // root *.log
		["a/note.log", true], // root *.log
		["b/tmp/data.txt", false] // nested tmp/ rule is scoped to a/
	];
	for (const [rel, expected] of cases) {
		const chain = await __test.chainForPath(job, rel);
		assert.equal(decideIgnored(chain, rel, false), expected, rel);
	}
});

test("watcher chainForPath returns an empty chain when the scope opts out", async () => {
	setFs(makeFs(TREE).fs);
	const job = { remoteRoot: new Uri(""), filter: { respectGitignore: false, excludeFiles: [], includeFiles: [] } };
	const chain = await __test.chainForPath(job, "a/b/keep.log");
	assert.deepEqual(chain, []);
});

// ── incremental copy (mirrorSubtree) writes to a real local dir ───────────────

test("incremental mirrorSubtree copies kept files and skips ignored ones on disk", async () => {
	const remote = makeFs(TREE);
	setFs(remote.fs);
	__test.gitignoreCache.clear();
	const tmpRoot = path.join(__dirname, "..", "tmp");
	await mkdir(tmpRoot, { recursive: true });
	const dest = await mkdtemp(path.join(tmpRoot, "mirror-"));
	try {
		await __test.mirrorSubtree(new Uri(""), "", dest, [], FILTER_ON, []);
		const got = await listFilesRel(dest);
		assert.deepEqual(
			got.sort(),
			[".gitignore", "a/.gitignore", "a/b/.gitignore", "a/b/keep.log", "b/tmp/data.txt", "keep.txt"].sort()
		);
	} finally {
		await rm(dest, { recursive: true, force: true });
	}
});

// ── config → filter mapping ──────────────────────────────────────────────────

test("buildScopeFilter maps config to the effective filter", () => {
	assert.equal(__test.buildScopeFilter(undefined).respectGitignore, true);
	assert.equal(__test.buildScopeFilter({ respectGitignore: false }).respectGitignore, false);
	const f = __test.buildScopeFilter({ excludeFiles: ["*.bak"], includeFiles: ["README.md"] });
	assert.ok(f.excludeFiles.includes("*.bak"), "config excludeFiles merged with the defaults");
	assert.deepEqual(f.includeFiles, ["README.md"]);
});
