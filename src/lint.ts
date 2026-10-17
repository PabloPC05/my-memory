import type { Conventions } from "./conventions.js";
import { MemoryError } from "./errors.js";
import { maskCode } from "./markdown.js";
import type { NoteRow, SearchIndex } from "./search-index.js";
import { dirOf, joinPath, lookAlikePairs, noteLabels, normalizeWords, topFolder } from "./util.js";

/**
 * Lint: the cheap, structural half of maintaining the memory. Everything here comes from the index and git dates,
 * with no model involved; it only finds candidates. Deciding whether two notes contradict each other, whether an
 * old inference still holds or how to split a note is the agent's job.
 */

/** Kinds in priority order: problems that break things first, housekeeping last. */
export const LINT_KINDS = [
	"problems",
	"broken_link",
	"duplicate_candidates",
	"old_inference",
	"missing_page",
	"unlinked_mention",
	"orphan",
	"stale",
	"oversized",
] as const;

export type LintKind = (typeof LINT_KINDS)[number];

export interface LintItem {
	kind: LintKind;
	notes: string[];
	detail: Record<string, unknown>;
}

export interface LintArgs {
	kinds?: string[];
	folder?: string;
	limit?: number;
}

export interface LintReport {
	counts: Partial<Record<LintKind, number>>;
	total: number;
	items: LintItem[];
	truncated: boolean;
	thresholds: { stale_days: number; inference_days: number; max_bytes: number; missing_page_min: number };
}

const DAY = 86_400_000;
const SNIPPET = 160;
/** Most source notes listed for one missing page. */
const MAX_SOURCES = 5;

function truncate(text: string, max = SNIPPET): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function daysSince(iso: string, now: number): number {
	return Math.floor((now - Date.parse(iso)) / DAY);
}

/** Words of a line with their offsets, normalized like `normalizeWords` (lowercase, no accents). */
function words(line: string): { word: string; at: number }[] {
	const out: { word: string; at: number }[] = [];
	for (const m of line.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
		for (const word of normalizeWords(m[0]).split(" ")) if (word) out.push({ word, at: m.index });
	}
	return out;
}

/** Whole-line window of `max` characters around an offset. */
function around(line: string, at: number, max = SNIPPET): string {
	if (line.length <= max) return truncate(line, max);
	const from = Math.max(0, Math.min(at - Math.floor(max / 3), line.length - max));
	return `${from > 0 ? "…" : ""}${line.slice(from, from + max - 2).replace(/\s+/g, " ").trim()}…`;
}

/** The sentence a provenance marker closes: the text before it on its line, from the previous sentence end. */
function sentenceBefore(line: string, at: number): string {
	const before = line
		.slice(0, at)
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
		.trimEnd();
	const pieces = before.split(/(?<=[.!?])\s+(?=\S)/);
	let sentence = pieces.pop() ?? "";
	// A marker right after a full stop belongs to the sentence that stop closed.
	if (sentence.trim() === "" && pieces.length) sentence = pieces.pop() as string;
	const t = sentence.replace(/\s+/g, " ").trim();
	return t.length > SNIPPET ? `…${t.slice(t.length - SNIPPET + 1)}` : t;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds the worklist. Pure over the index and the conventions, so the CLI can run it straight on the data dir. */
export function lint(index: SearchIndex, conventions: Conventions, args: LintArgs = {}, nowMs: number = Date.now()): LintReport {
	const settings = conventions.lint;
	const unknown = (args.kinds ?? []).filter((k) => !(LINT_KINDS as readonly string[]).includes(k));
	if (unknown.length) throw new MemoryError("INVALID_ARGUMENT", `Unknown lint kinds: ${unknown.join(", ")}. Use: ${LINT_KINDS.join(", ")}.`, { kinds: LINT_KINDS });
	const wanted = new Set<LintKind>(args.kinds?.length ? (args.kinds as LintKind[]) : LINT_KINDS);
	const folder = args.folder ? args.folder.replace(/\/+$/, "") : null;
	const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);

	const all = index.allNotes();
	const byPath = new Map(all.map((n) => [n.path, n]));
	// Root files and the archive are not held to the note rules; `[lint] exclude` adds folders of the repo's choosing.
	const inScope = (n: NoteRow | undefined): n is NoteRow => !!n && n.path.includes("/") && !n.archived && !settings.exclude.includes(n.folder);
	const notes = all.filter(inScope);
	const links = wanted.has("broken_link") || wanted.has("missing_page") || wanted.has("orphan") || wanted.has("unlinked_mention") ? index.allLinks() : [];
	const texts = wanted.has("old_inference") || wanted.has("unlinked_mention") ? index.sectionTexts().filter((s) => inScope(byPath.get(s.path))) : [];
	/** Path of a note's attachment binary: links to it count as links to the note. */
	const binaryOf = (n: NoteRow) => (n.attachment ? joinPath(dirOf(n.path), n.attachment) : null);
	const items: LintItem[] = [];

	if (wanted.has("problems")) {
		const byName = new Map<string, string[]>();
		for (const n of all) byName.set(n.name.toLowerCase(), [...(byName.get(n.name.toLowerCase()) ?? []), n.path]);
		for (const n of notes) {
			const problems = [...n.problems];
			if (n.supersededBy) problems.push(`superseded by [[${n.supersededBy}]] but not in the archive${conventions.folders.archive ? ` (${conventions.folders.archive}/)` : ""}`);
			for (const other of byName.get(n.name.toLowerCase()) ?? []) if (other !== n.path) problems.push(`duplicate name: also at ${other}`);
			if (problems.length) items.push({ kind: "problems", notes: [n.path], detail: { problems } });
		}
	}

	if (wanted.has("broken_link") || wanted.has("missing_page")) {
		// Missing targets linked from several notes are concepts that want their own page: one item for all of them.
		const byTarget = new Map<string, { sources: Map<string, number>; links: number }>();
		for (const l of links) {
			if (l.targetPath !== null || !inScope(byPath.get(l.srcPath))) continue;
			const t = byTarget.get(l.targetName) ?? { sources: new Map<string, number>(), links: 0 };
			if (!t.sources.has(l.srcPath)) t.sources.set(l.srcPath, l.line);
			t.links++;
			byTarget.set(l.targetName, t);
		}
		const missing: LintItem[] = [];
		for (const [target, t] of byTarget) {
			if (t.sources.size >= settings.missingPageMin) {
				if (wanted.has("missing_page")) missing.push({ kind: "missing_page", notes: [...t.sources.keys()], detail: { target, notes: t.sources.size, links: t.links } });
			} else if (wanted.has("broken_link")) {
				for (const [src, line] of t.sources) items.push({ kind: "broken_link", notes: [src], detail: { target, line } });
			}
		}
		missing.sort((a, b) => (b.detail.notes as number) - (a.detail.notes as number) || (b.detail.links as number) - (a.detail.links as number));
		items.push(...missing);
	}

	if (wanted.has("duplicate_candidates")) {
		for (const p of lookAlikePairs(notes.map((n) => ({ item: n.path, labels: noteLabels(n) })))) {
			items.push({ kind: "duplicate_candidates", notes: [p.a, p.b], detail: { labels: p.labels } });
		}
	}

	if (wanted.has("old_inference") && settings.inferredMarkers.length) {
		const marker = new RegExp(`\\((?:${settings.inferredMarkers.map(escapeRegExp).join("|")})(?:\\s*[,;:]\\s*(\\d{4}-\\d{2}-\\d{2}))?\\s*\\)`, "giu");
		const found: { item: LintItem; days: number }[] = [];
		for (const s of texts) {
			const note = byPath.get(s.path) as NoteRow;
			const raw = s.text.split("\n");
			const masked = maskCode(s.text).split("\n");
			masked.forEach((line, i) => {
				for (const m of line.matchAll(marker)) {
					const date = m[1] ?? null;
					// Undated: the statement is at least as old as the note's last change.
					const since = date ?? note.updatedAt;
					if (!since || Number.isNaN(Date.parse(since))) continue;
					const days = daysSince(since, nowMs);
					if (days <= settings.inferenceDays) continue;
					const detail: Record<string, unknown> = { line: s.lineStart + i, section: s.heading, date, days, snippet: sentenceBefore(raw[i] ?? "", m.index) };
					if (!date) detail.unchanged_since = note.updatedAt?.slice(0, 10);
					found.push({ item: { kind: "old_inference", notes: [s.path], detail }, days });
				}
			});
		}
		found.sort((a, b) => b.days - a.days);
		items.push(...found.map((f) => f.item));
	}

	if (wanted.has("unlinked_mention")) {
		// Labels of every note (and their leading words, to grow phrases); a label several notes share is ambiguous.
		const owners = new Map<string, Set<string>>();
		for (const n of notes) {
			for (const label of noteLabels(n)) {
				const norm = normalizeWords(label);
				if (norm.length < settings.mentionMinLength) continue;
				owners.set(norm, (owners.get(norm) ?? new Set()).add(n.path));
			}
		}
		const targets = new Map<string, string>();
		const prefixes = new Set<string>();
		let longest = 1;
		for (const [label, paths] of owners) {
			if (paths.size !== 1) continue;
			targets.set(label, [...paths][0] as string);
			const w = label.split(" ");
			longest = Math.max(longest, w.length);
			for (let k = 1; k <= w.length; k++) prefixes.add(w.slice(0, k).join(" "));
		}
		const linked = new Set<string>();
		for (const l of links) if (l.targetPath) linked.add(`${l.srcPath}\0${l.targetPath}`);
		const linksTo = (src: string, target: NoteRow) => linked.has(`${src}\0${target.path}`) || (binaryOf(target) !== null && linked.has(`${src}\0${binaryOf(target)}`));
		const pairs = new Map<string, { src: string; target: string; label: string; line: number; snippet: string; count: number }>();
		for (const s of texts) {
			const raw = s.text.split("\n");
			// Links, code and headings are not plain mentions.
			const masked = maskCode(s.text)
				.replace(/!?\[\[[^\]\n]*\]\]/g, (m) => " ".repeat(m.length))
				.split("\n");
			masked.forEach((line, i) => {
				if (/^\s{0,3}#/.test(line)) return;
				const w = words(line);
				for (let p = 0; p < w.length; p++) {
					// Grow the phrase word by word while it is still the start of some label.
					let phrase = "";
					for (let k = p; k < w.length && k < p + longest; k++) {
						phrase = phrase ? `${phrase} ${(w[k] as { word: string }).word}` : (w[k] as { word: string }).word;
						if (!prefixes.has(phrase)) break;
						const target = targets.get(phrase);
						if (!target || target === s.path) continue;
						const key = `${s.path}\0${target}`;
						const seen = pairs.get(key);
						if (seen) {
							seen.count++;
							continue;
						}
						if (linksTo(s.path, byPath.get(target) as NoteRow)) continue;
						pairs.set(key, { src: s.path, target, label: phrase, line: s.lineStart + i, snippet: around(raw[i] ?? "", (w[p] as { at: number }).at), count: 1 });
					}
				}
			});
		}
		const found = [...pairs.values()].sort((a, b) => b.count - a.count || a.src.localeCompare(b.src));
		for (const f of found) items.push({ kind: "unlinked_mention", notes: [f.src, f.target], detail: { label: f.label, line: f.line, mentions: f.count, snippet: f.snippet } });
	}

	if (wanted.has("orphan")) {
		const incoming = new Set<string>();
		const outgoing = new Map<string, number>();
		for (const l of links) {
			outgoing.set(l.srcPath, (outgoing.get(l.srcPath) ?? 0) + 1);
			if (!l.targetPath || l.targetPath === l.srcPath) continue;
			const src = byPath.get(l.srcPath);
			// Root files count (an instructions file that links a note keeps it alive); archived notes do not.
			if (src?.archived) continue;
			incoming.add(l.targetPath);
		}
		for (const n of notes) {
			if (settings.orphanExclude.includes(n.folder)) continue;
			const bin = binaryOf(n);
			if (incoming.has(n.path) || (bin && incoming.has(bin))) continue;
			items.push({ kind: "orphan", notes: [n.path], detail: { links_out: outgoing.get(n.path) ?? 0 } });
		}
	}

	if (wanted.has("stale")) {
		const found: { item: LintItem; days: number }[] = [];
		for (const n of notes) {
			if (!n.updatedAt) continue;
			const days = daysSince(n.updatedAt, nowMs);
			if (days > settings.staleDays) found.push({ item: { kind: "stale", notes: [n.path], detail: { updated_at: n.updatedAt.slice(0, 10), days } }, days });
		}
		found.sort((a, b) => b.days - a.days);
		items.push(...found.map((f) => f.item));
	}

	if (wanted.has("oversized")) {
		const sections = index.sectionCounts();
		const big = notes.filter((n) => !n.attachment && n.size > settings.maxBytes).sort((a, b) => b.size - a.size);
		for (const n of big) items.push({ kind: "oversized", notes: [n.path], detail: { bytes: n.size, sections: sections.get(n.path) ?? 0 } });
	}

	const selected = folder ? items.filter((it) => it.notes.some((p) => topFolder(p) === folder)) : items;
	const rank = (k: LintKind) => LINT_KINDS.indexOf(k);
	// Stable sort: each kind keeps the order it was built in (worst first).
	selected.sort((a, b) => rank(a.kind) - rank(b.kind));
	const counts: Partial<Record<LintKind, number>> = {};
	for (const k of LINT_KINDS) if (wanted.has(k)) counts[k] = 0;
	for (const it of selected) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
	const page = selected.slice(0, limit).map((it) => (it.kind === "missing_page" && it.notes.length > MAX_SOURCES ? { ...it, notes: it.notes.slice(0, MAX_SOURCES) } : it));
	return {
		counts,
		total: selected.length,
		items: page,
		truncated: selected.length > limit,
		thresholds: { stale_days: settings.staleDays, inference_days: settings.inferenceDays, max_bytes: settings.maxBytes, missing_page_min: settings.missingPageMin },
	};
}

/** Plain-text rendering for the CLI: counts, then one line per item. */
export function renderLint(report: LintReport): string {
	const lines = [`${report.total} item(s): ${Object.entries(report.counts).map(([k, n]) => `${k} ${n}`).join(", ")}`];
	for (const it of report.items) {
		const d = Object.entries(it.detail)
			.filter(([, v]) => v !== null && v !== undefined)
			.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(" | ") : String(v)}`)
			.join("  ");
		lines.push(`${it.kind.padEnd(20)} ${it.notes.join(it.kind === "missing_page" ? ", " : " ↔ ")}  ${d}`);
	}
	if (report.truncated) lines.push(`… ${report.total - report.items.length} more (raise --limit or filter by kind)`);
	return lines.join("\n");
}
