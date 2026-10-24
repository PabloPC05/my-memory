import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MemoryError } from "./errors.js";
import type { Conventions } from "./conventions.js";

/** Git blob SHA-1 of a file's content: the `hash` clients send back to `write`, `move` and `delete`. */
export function blobHash(content: string | Buffer): string {
	const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
	return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function randomToken(prefix = ""): string {
	return prefix + randomBytes(32).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/** Serializes async work: one writer at a time. */
export class Mutex {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.tail.then(fn, fn);
		this.tail = result.catch(() => undefined);
		return result;
	}
}

/** Lowercase, no accents, words separated by single spaces. */
export function normalizeWords(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = cur;
	}
	return prev[b.length] as number;
}

/**
 * Whether two labels (names, titles or aliases) look like the same thing: equal once normalized,
 * a small edit distance (typos), or one's words all contained in the other's (for labels of 6+ characters).
 */
export function looksLikeSame(a: string, b: string): boolean {
	return sameNormalized(normalizeWords(a), normalizeWords(b));
}

/**
 * Most typos `looksLikeSame` forgives between two normalized labels: a quarter of a single word, but much less
 * across several words ("piso de oviedo" is not "piso de toledo"). The largest d with d / longest <= tolerance.
 */
function maxTypos(x: string, y: string): number {
	return typoBudget(Math.max(x.length, y.length), x.includes(" ") || y.includes(" "));
}

function typoBudget(longest: number, severalWords: boolean): number {
	const tolerance = severalWords ? 0.12 : 0.25;
	const k = Math.floor(longest * tolerance);
	return (k + 1) / longest <= tolerance ? k + 1 : k;
}

/** Two rows of the edit-distance table, reused between calls. */
let rows = [new Int32Array(64), new Int32Array(64)];

/** Whether the edit distance between two strings is at most k: only the diagonal band, stopping early. */
function withinDistance(a: string, b: string, k: number): boolean {
	if (Math.abs(a.length - b.length) > k) return false;
	if (k === 0) return a === b;
	const over = k + 1;
	if ((rows[0] as Int32Array).length <= b.length) rows = [new Int32Array(b.length * 2), new Int32Array(b.length * 2)];
	let [prev, cur] = rows as [Int32Array, Int32Array];
	for (let j = 0; j <= b.length; j++) prev[j] = Math.min(j, over);
	for (let i = 1; i <= a.length; i++) {
		cur.fill(over, 0, b.length + 1);
		cur[0] = Math.min(i, over);
		let best = cur[0] as number;
		for (let j = Math.max(1, i - k); j <= Math.min(b.length, i + k); j++) {
			const v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1), over);
			cur[j] = v;
			if (v < best) best = v;
		}
		if (best > k) return false;
		[prev, cur] = [cur, prev];
	}
	return (prev[b.length] as number) <= k;
}

/** `looksLikeSame` on labels already passed through `normalizeWords`: equal, a few typos, or contained. */
function sameNormalized(x: string, y: string): boolean {
	if (!x || !y) return false;
	return x === y || withinDistance(x, y, maxTypos(x, y)) || contained(x, y);
}

/** All the words of the shorter label, if it has 6+ characters, appear in the longer one. */
function contained(x: string, y: string): boolean {
	const [short, long] = x.length <= y.length ? [x, y] : [y, x];
	if (short.length < 6) return false;
	const longWords = new Set(long.split(" "));
	return short.split(" ").every((w) => longWords.has(w));
}

/** The labels a note is known by, for look-alike checks: its name (dashes as spaces), title and aliases. */
export function noteLabels(note: { name: string; title: string | null; aliases: string[] }): string[] {
	return [note.name.replace(/-/g, " "), note.title ?? "", ...note.aliases].filter((l) => normalizeWords(l) !== "");
}

/** The first pair of labels, one from each list, that look like the same thing, or null. */
export function lookAlikeLabels(a: string[], b: string[]): [string, string] | null {
	for (const x of a) for (const y of b) if (looksLikeSame(x, y)) return [x, y];
	return null;
}

/**
 * Every pair of items with look-alike labels, without comparing all pairs. Candidates come from filters that
 * cannot miss a pair `looksLikeSame` accepts, and each candidate is then checked with the matching rule:
 * - typos: two strings within edit distance k share at least max(|x|, |y|) - 1 - 2k bigrams, counted with
 *   repetition (the q-gram lemma), and k is bounded by the same tolerance, as is the length difference; so a
 *   bigram index, walked only over labels of a reachable length, counts the shared bigrams of every candidate;
 * - containment: every word of the shorter label is in the longer one, so the longer one is in the index of the
 *   shorter label's rarest word.
 */
export function lookAlikePairs<T>(items: { item: T; labels: string[] }[]): { a: T; b: T; labels: [string, string] }[] {
	type Entry = { owner: number; label: string; norm: string; words: string[]; grams: number[]; severalWords: boolean };
	const entries: Entry[] = [];
	items.forEach((it, owner) => {
		const seen = new Set<string>();
		for (const label of it.labels) {
			const norm = normalizeWords(label);
			if (!norm || seen.has(norm)) continue;
			seen.add(norm);
			const words = norm.split(" ");
			entries.push({ owner, label, norm, words, grams: [], severalWords: words.length > 1 });
		}
	});
	// Shortest first, so the labels a label can match by typos sit in a window right after it.
	entries.sort((a, b) => a.norm.length - b.norm.length || a.owner - b.owner);
	const lastOfLength: number[] = [];
	entries.forEach((e, i) => {
		lastOfLength[e.norm.length] = i;
	});
	const lastUpTo = (length: number) => {
		for (let l = Math.min(length, lastOfLength.length - 1); l >= 0; l--) if (lastOfLength[l] !== undefined) return lastOfLength[l] as number;
		return -1;
	};

	const gramIds = new Map<string, number>();
	const gramPostings: number[][] = [];
	const wordPostings = new Map<string, number[]>();
	const exact = new Map<string, number[]>();
	entries.forEach((e, i) => {
		// Bigrams numbered by occurrence ("ab" twice is "ab#1" and "ab#2"), so shared ids count with repetition.
		const occurrences = new Map<string, number>();
		for (let k = 0; k + 1 < e.norm.length; k++) {
			const g = e.norm.slice(k, k + 2);
			const n = (occurrences.get(g) ?? 0) + 1;
			occurrences.set(g, n);
			const key = `${g}#${n}`;
			let id = gramIds.get(key);
			if (id === undefined) {
				id = gramPostings.length;
				gramIds.set(key, id);
				gramPostings.push([]);
			}
			e.grams.push(id);
			(gramPostings[id] as number[]).push(i);
		}
		e.grams.sort((x, y) => x - y);
		for (const w of new Set(e.words)) {
			const list = wordPostings.get(w);
			if (list) list.push(i);
			else wordPostings.set(w, [i]);
		}
		const same = exact.get(e.norm);
		if (same) same.push(i);
		else exact.set(e.norm, [i]);
	});

	const found = new Map<number, { a: T; b: T; labels: [string, string] }>();
	// Each filter confirms its own branch of `sameNormalized`; together they accept exactly the same pairs.
	const consider = (x: Entry, y: Entry, same: (a: string, b: string) => boolean) => {
		if (x.owner === y.owner) return;
		const [lo, hi] = x.owner < y.owner ? [x, y] : [y, x];
		const id = lo.owner * items.length + hi.owner;
		if (found.has(id) || !same(lo.norm, hi.norm)) return;
		found.set(id, { a: (items[lo.owner] as (typeof items)[number]).item, b: (items[hi.owner] as (typeof items)[number]).item, labels: [lo.label, hi.label] });
	};
	const shared = new Int32Array(entries.length);
	entries.forEach((e, i) => {
		for (const j of exact.get(e.norm) as number[]) if (j > i) consider(e, entries[j] as Entry, () => true);
		// Longest partner reachable by typos (a single-word label allows the most, so it bounds every pair it is in).
		let longest = e.norm.length;
		while (longest + 1 - e.norm.length <= typoBudget(longest + 1, e.severalWords)) longest++;
		const upTo = lastUpTo(longest);
		const touched: number[] = [];
		for (const g of e.grams) {
			// Postings are in ascending order: the reachable labels after this one are a contiguous run.
			const list = gramPostings[g] as number[];
			let lo = 0;
			let hi = list.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if ((list[mid] as number) <= upTo) lo = mid + 1;
				else hi = mid;
			}
			for (let p = lo - 1; p >= 0 && (list[p] as number) > i; p--) {
				const j = list[p] as number;
				if (shared[j] === 0) touched.push(j);
				shared[j] = (shared[j] as number) + 1;
			}
		}
		for (const j of touched) {
			const other = entries[j] as Entry;
			const k = typoBudget(other.norm.length, e.severalWords || other.severalWords);
			const need = other.norm.length - 1 - 2 * k;
			if (need > 0 && (shared[j] as number) >= need && other.norm.length - e.norm.length <= k) consider(e, other, (x, y) => withinDistance(x, y, k));
			shared[j] = 0;
		}
		if (e.norm.length >= 6) {
			let rarest = wordPostings.get(e.words[0] as string) as number[];
			for (const w of e.words) {
				const list = wordPostings.get(w) as number[];
				if (list.length < rarest.length) rarest = list;
			}
			for (const j of rarest) if (j > i) consider(e, entries[j] as Entry, contained);
		}
	});
	return [...found.entries()].sort((x, y) => x[0] - y[0]).map(([, pair]) => pair);
}

/** Name of a note: its file's basename without `.md`. */
export function noteName(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

export function topFolder(path: string): string {
	const i = path.indexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, file: string): string {
	return dir ? `${dir}/${file}` : file;
}

/**
 * Normalizes and checks a repo-relative path given by a client. `kind: "note"` requires `.md`; `"asset"` forbids it.
 * Does not touch the filesystem (symlinks are checked by the caller).
 */
export function checkPath(input: unknown, conventions: Conventions, kind: "note" | "asset"): string {
	if (typeof input !== "string" || input.trim() === "") throw new MemoryError("INVALID_PATH", "A path is required.");
	const path = input.trim().replace(/^\.\//, "");
	const bad = (why: string) => new MemoryError("INVALID_PATH", `Invalid path «${input}»: ${why}.`, { path: input });
	if (path.includes("\\")) throw bad("use forward slashes");
	if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw bad("it must be relative to the repo root");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\u0000-\u001f\u007f]/.test(path)) throw bad("control characters are not allowed");
	const parts = path.split("/");
	if (parts.some((p) => p === "" || p === "." || p === "..")) throw bad("empty, «.» or «..» segments are not allowed");
	if (parts.some((p) => p.startsWith("."))) throw bad("hidden files and folders (like .git) are off limits");
	const isMd = /\.md$/i.test(path);
	if (kind === "note" && !isMd) throw bad("notes must end in .md");
	if (kind === "asset" && (isMd || !/\.[A-Za-z0-9]+$/.test(path))) throw bad("attachments need a non-.md extension");
	if (parts.length === 1) {
		if (kind === "asset" || !conventions.folders.rootFiles.includes(path)) {
			throw bad(`only ${conventions.folders.rootFiles.join(", ") || "no files"} may live at the root; put it in a folder`);
		}
	} else if (conventions.folders.allowed && !conventions.folders.allowed.includes(parts[0] as string)) {
		throw bad(`«${parts[0]}» is not one of the allowed folders (${conventions.folders.allowed.join(", ")})`);
	}
	return path;
}

/** New names must follow the repo's filename pattern; attachments are checked as if they were `<stem>.md`. */
export function checkNewFilename(path: string, conventions: Conventions): void {
	const file = path.split("/").pop() as string;
	const asNote = `${file.replace(/\.[^.]+$/, "")}.md`;
	if (!conventions.notes.filenamePattern.test(asNote)) {
		throw new MemoryError("INVALID_FILENAME", `«${file}» does not match the repo's filename pattern ${conventions.notes.filenamePattern.source}.`, { path, pattern: conventions.notes.filenamePattern.source });
	}
}

/** `since` for `recent`: an ISO date (`2026-05-01`, `2026-05-01T10:00`) or an age like `30m`, `12h`, `7d`, `2w`. Returns an ISO timestamp. */
export function parseSince(input: string, now = Date.now()): string {
	const text = input.trim();
	const age = /^(\d+)\s*(m|min|h|d|w)$/i.exec(text);
	if (age) {
		const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[(age[2] as string).toLowerCase() as "m" | "min" | "h" | "d" | "w"];
		return new Date(now - Number(age[1]) * unit).toISOString();
	}
	const at = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(text) ? Date.parse(text) : Number.NaN;
	if (Number.isNaN(at)) throw new MemoryError("INVALID_ARGUMENT", `«since» must be an ISO date like 2026-05-01 or an age like 7d, 12h, 2w; got «${input}».`);
	return new Date(at).toISOString();
}

export interface FileChange {
	/** First letter of git's status: A, M, D, R (moved), C (copied), T (type changed). */
	status: string;
	path: string;
	/** Previous path, for R and C. */
	from?: string;
}

/** Unquotes a path that git printed C-style (only happens for unusual characters, since core.quotepath is off). */
function unquoteGitPath(p: string): string {
	if (!p.startsWith('"')) return p;
	try {
		return JSON.parse(p) as string;
	} catch {
		return p.slice(1, -1);
	}
}

/** Parses `--name-status` lines (`M\tpath`, `R096\told\tnew`). */
export function parseNameStatus(text: string): FileChange[] {
	const changes: FileChange[] = [];
	for (const line of text.split("\n")) {
		const [status, a, b] = line.replace(/\r$/, "").split("\t");
		if (!status || !a || !/^[ACDMRTUX]/.test(status)) continue;
		const s = status[0] as string;
		if ((s === "R" || s === "C") && b) changes.push({ status: s, path: unquoteGitPath(b), from: unquoteGitPath(a) });
		else changes.push({ status: s, path: unquoteGitPath(a) });
	}
	return changes;
}

/** `fn` over the items, at most `limit` at a time; results in the items' order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i] as T);
			}
		}),
	);
	return out;
}
