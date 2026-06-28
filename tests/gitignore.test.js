"use strict";

/**
 * Tests for the pure `.gitignore` matcher (src/gitignore.ts → out/gitignore.js).
 *
 * Uses Node's built-in test runner (`node --test`) against the COMPILED module,
 * so there is no test-framework dependency to add to a single-file extension.
 * `pnpm test` runs `pnpm run compile` first, so out/gitignore.js is always fresh.
 *
 * The matcher is pure (no `vscode`), so the per-directory semantics the live
 * walk relies on — root rules everywhere, nested rules scoped to their subtree,
 * deeper `!` re-includes, last-match-wins — are all exercisable here by building
 * the same `IgnoreChain` the walk would thread, without standing up a fake
 * remote filesystem. The IO/caching layer (rulesForDir/extendChain/chainForPath
 * in extension.ts) is thin glue over this and is covered by the type checker and
 * the live walk; it is not unit-tested here as that would require a vscode stub.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compileIgnore, decideIgnored } = require("../out/gitignore.js");

/** Build one chain link (an `IgnoreScope`) at `baseRel` from raw `.gitignore` lines. */
function scope(baseRel, ...lines) {
	const rules = [];
	for (const line of lines) {
		const r = compileIgnore(line);
		if (r) rules.push(r);
	}
	return { baseRel, rules };
}

// ── compileIgnore ──────────────────────────────────────────────────────────

test("compileIgnore: blanks, comments, and bare `!` compile to undefined", () => {
	assert.equal(compileIgnore(""), undefined);
	assert.equal(compileIgnore("   "), undefined);
	assert.equal(compileIgnore("\t"), undefined);
	assert.equal(compileIgnore("# a comment"), undefined);
	assert.equal(compileIgnore("!"), undefined);
});

test("compileIgnore: leading `!` sets the negate flag and compiles the rest", () => {
	const r = compileIgnore("!keep.log");
	assert.ok(r);
	assert.equal(r.negate, true);
	assert.equal(r.dirOnly, false);
	assert.ok(r.pattern.test("keep.log"));
});

test("compileIgnore: trailing `/` is directory-only", () => {
	const r = compileIgnore("tmp/");
	assert.equal(r.dirOnly, true);
	assert.equal(r.negate, false);
	assert.ok(r.pattern.test("tmp"));
});

test("compileIgnore: escaped leading `\\#` / `\\!` are literal, not comment/negation", () => {
	const hash = compileIgnore("\\#literal");
	assert.ok(hash);
	assert.equal(hash.negate, false);
	assert.ok(hash.pattern.test("#literal"));

	const bang = compileIgnore("\\!literal");
	assert.ok(bang);
	assert.equal(bang.negate, false);
	assert.ok(bang.pattern.test("!literal"));
});

test("compileIgnore: leading `/` and internal `/` anchor; bare names float", () => {
	const anchored = compileIgnore("/build");
	assert.ok(anchored.pattern.test("build"));
	assert.equal(anchored.pattern.test("a/build"), false);

	const internal = compileIgnore("a/b");
	assert.ok(internal.pattern.test("a/b"));
	assert.equal(internal.pattern.test("x/a/b"), false);

	const floating = compileIgnore("node_modules");
	assert.ok(floating.pattern.test("node_modules"));
	assert.ok(floating.pattern.test("a/b/node_modules"));
});

test("compileIgnore: `*` stops at `/`, `**` spans depths", () => {
	const star = compileIgnore("*.log");
	assert.ok(star.pattern.test("a.log"));
	assert.ok(star.pattern.test("deep/dir/a.log"));
	assert.equal(compileIgnore("/*.log").pattern.test("deep/a.log"), false);

	const ds = compileIgnore("a/**/c");
	assert.ok(ds.pattern.test("a/c"));
	assert.ok(ds.pattern.test("a/b/c"));
	assert.ok(ds.pattern.test("a/b/x/c"));
});

// ── decideIgnored ──────────────────────────────────────────────────────────

test("decideIgnored: a root rule applies at every depth", () => {
	const chain = [scope("", "*.log")];
	assert.equal(decideIgnored(chain, "a.log", false), true);
	assert.equal(decideIgnored(chain, "deep/nested/b.log", false), true);
	assert.equal(decideIgnored(chain, "a.txt", false), false);
});

test("decideIgnored: a nested rule applies only within its own subtree", () => {
	// a/.gitignore = `tmp/`  ⇒  a/tmp ignored, b/tmp kept.
	const chain = [scope("a", "tmp/")];
	assert.equal(decideIgnored(chain, "a/tmp", true), true);
	assert.equal(decideIgnored(chain, "b/tmp", true), false);
});

test("decideIgnored: a directory-only rule ignores the dir, not a same-named file", () => {
	const chain = [scope("", "dist/")];
	assert.equal(decideIgnored(chain, "dist", true), true);
	assert.equal(decideIgnored(chain, "dist", false), false);
});

test("decideIgnored: last match wins within a file, with negation", () => {
	const chain = [scope("", "build", "!build/keep", "build/keep/secret")];
	assert.equal(decideIgnored(chain, "build", true), true); // ignored
	assert.equal(decideIgnored(chain, "build/keep", true), false); // re-included
	assert.equal(decideIgnored(chain, "build/keep/secret", true), true); // re-ignored (last wins)
});

test("decideIgnored: a deeper scope overrides a shallower decision", () => {
	const chain = [scope("", "*.log"), scope("a/b", "!keep.log")];
	assert.equal(decideIgnored(chain, "a/b/keep.log", false), false); // rescued by deeper !
	assert.equal(decideIgnored(chain, "a/b/other.log", false), true); // still ignored
	assert.equal(decideIgnored(chain, "a/keep.log", false), true); // negation scoped to a/b
});

test("decideIgnored: plan fixture — root `*.log`, a/`tmp/`, a/b/`!keep.log`", () => {
	const chain = [scope("", "*.log"), scope("a", "tmp/"), scope("a/b", "!keep.log")];
	// root *.log skipped at all depths
	assert.equal(decideIgnored(chain, "x.log", false), true);
	assert.equal(decideIgnored(chain, "a/y.log", false), true);
	// a/.gitignore tmp/ ⇒ a/tmp skipped, b/tmp kept
	assert.equal(decideIgnored(chain, "a/tmp", true), true);
	assert.equal(decideIgnored(chain, "b/tmp", true), false);
	// a/b/.gitignore !keep.log re-includes under the root *.log
	assert.equal(decideIgnored(chain, "a/b/keep.log", false), false);
	assert.equal(decideIgnored(chain, "a/b/drop.log", false), true);
});

test("decideIgnored: an empty chain ignores nothing (gitignore layer off)", () => {
	assert.equal(decideIgnored([], "anything/at/all.log", false), false);
	assert.equal(decideIgnored([], "node_modules", true), false);
});
