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
	const x = normalizeWords(a);
	const y = normalizeWords(b);
	if (!x || !y) return false;
	if (x === y) return true;
	// Typos: a quarter of a single word, but much less across several words ("piso de oviedo" is not "piso de toledo").
	const tolerance = x.includes(" ") || y.includes(" ") ? 0.12 : 0.25;
	if (levenshtein(x, y) / Math.max(x.length, y.length) <= tolerance) return true;
	const [short, long] = x.length <= y.length ? [x, y] : [y, x];
	if (short.length < 6) return false;
	const longWords = new Set(long.split(" "));
	return short.split(" ").every((w) => longWords.has(w));
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
