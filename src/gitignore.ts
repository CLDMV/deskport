/**
 * Pure `.gitignore` matching — compile lines to rules and decide, against a
 * per-directory rule chain, whether a path is ignored.
 *
 * Deliberately free of any `vscode` import so it can be unit-tested with plain
 * Node. The IO half — reading `.gitignore` files off the remote and caching
 * them — lives in `extension.ts`; this module is just the matcher.
 *
 * Git's model is per-directory: every directory may carry its own
 * `.gitignore`, its patterns are interpreted relative to that file's
 * directory, deeper files take precedence, and `!` re-includes. An
 * {@link IgnoreChain} captures that — one {@link IgnoreScope} per `.gitignore`
 * on a path, ordered shallow → deep.
 */

/** A single rule from a `.gitignore` file, compiled to a regex. */
export interface IgnoreRule {
	pattern: RegExp;
	/** True if the original line ended with `/` — matches only directories. */
	dirOnly: boolean;
	/** True if the line began with `!` — a re-include that flips the decision. */
	negate: boolean;
}

/** The compiled rules of one `.gitignore`, tagged with the directory it lives in. */
export interface IgnoreScope {
	/** Scope-root-relative path of the directory holding this `.gitignore` (`""` for the scope root). */
	baseRel: string;
	rules: readonly IgnoreRule[];
}

/** An ordered (shallow → deep) chain of per-directory rule-sets applying to a path. */
export type IgnoreChain = readonly IgnoreScope[];

/**
 * Compile one `.gitignore` line to a rule. Returns `undefined` for blank lines
 * and `#` comments.
 *
 * A leading `!` is a negation (re-include): it is stripped, the rest is
 * compiled, and {@link IgnoreRule.negate} is set so {@link decideIgnored} can
 * flip a prior match back to "not ignored". A leading `\#` / `\!` is an escaped
 * literal `#` / `!`. Pattern flavors: a trailing `/` is directory-only; a
 * leading or internal `/` anchors to the scope's directory; an unanchored
 * pattern matches at any depth below it; `**` spans depths.
 */
export function compileIgnore(rawLine: string): IgnoreRule | undefined {
	let p = rawLine.replace(/\r$/, "");
	// Trim trailing whitespace but preserve an escaped trailing space (rare).
	p = p.replace(/(?<!\\)\s+$/, "");
	if (!p || p.startsWith("#")) return undefined;
	let negate = false;
	if (p.startsWith("!")) {
		negate = true;
		p = p.slice(1);
	} else if (p.startsWith("\\#") || p.startsWith("\\!")) {
		// Escaped leading `#` / `!` — a literal first character, not a comment/negation.
		p = p.slice(1);
	}
	if (!p) return undefined;
	let dirOnly = false;
	if (p.endsWith("/")) {
		dirOnly = true;
		p = p.slice(0, -1);
	}
	// A leading `/` or an internal `/` anchors the pattern to the scope's directory.
	let anchored = false;
	if (p.startsWith("/")) {
		anchored = true;
		p = p.slice(1);
	} else if (p.includes("/")) {
		anchored = true;
	}
	try {
		// Escape regex metacharacters, then substitute the glob tokens back in.
		// `*` and `?` are in the escape set so they survive as `\*` / `\?` for the
		// targeted replacements below.
		let re = p.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
		re = re.replace(/\\\*\\\*\//g, "(?:.*/)?").replace(/\/\\\*\\\*/g, "(?:/.*)?").replace(/\\\*\\\*/g, ".*");
		re = re.replace(/\\\*/g, "[^/]*").replace(/\\\?/g, "[^/]");
		const final = anchored ? new RegExp(`^${re}(?:/.*)?$`) : new RegExp(`(?:^|.*/)${re}(?:/.*)?$`);
		return { pattern: final, dirOnly, negate };
	} catch {
		return undefined;
	}
}

/**
 * Decide whether a scope-root-relative path is ignored, given the chain of
 * `.gitignore` rule-sets that apply to it (shallow → deep).
 *
 * Last match wins — across scopes (shallow → deep) and within each scope
 * (top → bottom) — matching git. A negated rule (`!pattern`) flips the running
 * decision back to "not ignored", so a deeper re-include can rescue a path an
 * ancestor pattern ignored. (A path under a directory that is itself ignored is
 * never reached: the walk does not descend into an ignored directory, so the
 * "parent-ignored is terminal" rule holds without special-casing here.)
 */
export function decideIgnored(chain: IgnoreChain, rel: string, isDir: boolean): boolean {
	let ignored = false;
	for (const scope of chain) {
		// A scope's rules apply to its own directory and everything beneath it.
		const prefix = scope.baseRel ? scope.baseRel + "/" : "";
		if (rel !== scope.baseRel && !rel.startsWith(prefix)) continue;
		// Re-base the path onto this `.gitignore`'s directory before matching.
		const sub = scope.baseRel ? rel.slice(scope.baseRel.length + 1) : rel;
		for (const r of scope.rules) {
			if (r.dirOnly && !isDir) continue;
			if (r.pattern.test(sub)) ignored = !r.negate;
		}
	}
	return ignored;
}
