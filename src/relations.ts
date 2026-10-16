import { splitFrontmatter } from "./frontmatter.js";
import { lineAt, lineOffsets, maskCode, parseWikiLinks, type WikiLink } from "./markdown.js";

/**
 * Typed links, written as Dataview inline fields: `key:: [[x]]` on its own line (optionally a list item),
 * `[key:: [[x]]]` or `(key:: [[x]])` inside a sentence, or `key: "[[x]]"` in the frontmatter.
 * Every wikilink in the field's value gets the key as its relation; other links have none.
 */
export interface TypedLink extends WikiLink {
	relation: string | null;
}

const KEY = String.raw`[\p{L}_][\p{L}\p{N}_-]*`;
export const RELATION_KEY = new RegExp(`^${KEY}$`, "u");
const LINE_FIELD = new RegExp(String.raw`^\s*(?:[-*+]\s+|\d+[.)]\s+)?(${KEY})::(?=\s|$)`, "u");
const INLINE_FIELD = new RegExp(String.raw`[[(](${KEY})::(?=\s)`, "gu");
const FRONTMATTER_KEY = new RegExp(`^(${KEY}):`, "u");

/** Frontmatter fields that hold text, not relations, even when they contain a link. */
const NOT_RELATIONS = new Set(["name", "description", "aliases", "attachment"]);

export function parseTypedLinks(text: string): TypedLink[] {
	const links = parseWikiLinks(text);
	if (links.length === 0) return [];
	const split = splitFrontmatter(text);
	// Lines 1..frontmatterEnd are the frontmatter, delimiters included.
	const frontmatterEnd = split.yaml === null ? 0 : split.bodyLine - 1;
	const lines = text.split("\n");
	const masked = maskCode(text).split("\n");
	const starts = lineOffsets(text);
	const spansByLine = new Map<number, { from: number; to: number; key: string }[]>();
	return links.map((link) => {
		const line = link.line;
		if (line <= frontmatterEnd) return { ...link, relation: frontmatterRelation(lines, line) };
		let spans = spansByLine.get(line);
		if (!spans) {
			spans = fieldSpans(masked[line - 1] ?? "");
			spansByLine.set(line, spans);
		}
		const column = link.start - (starts[lineAt(starts, link.start)] as number);
		const span = spans.find((s) => column >= s.from && column < s.to);
		return { ...link, relation: span ? span.key : null };
	});
}

const LIST_ITEM = /^\s*-\s/;

/** The key a frontmatter line belongs to: its own `key:` or, for block list items, the key above the list. */
function frontmatterRelation(lines: string[], line: number): string | null {
	let i = line - 1;
	if (!FRONTMATTER_KEY.test(lines[i] as string)) {
		if (!LIST_ITEM.test(lines[i] as string)) return null;
		do i--;
		while (i >= 1 && LIST_ITEM.test(lines[i] as string));
	}
	const m = FRONTMATTER_KEY.exec(lines[i] ?? "");
	if (!m) return null;
	const key = (m[1] as string).toLowerCase();
	return NOT_RELATIONS.has(key) ? null : key;
}

/** Column ranges of a body line covered by inline fields, bracketed ones first so they win over a line field. */
function fieldSpans(line: string): { from: number; to: number; key: string }[] {
	const spans: { from: number; to: number; key: string }[] = [];
	INLINE_FIELD.lastIndex = 0;
	for (let m = INLINE_FIELD.exec(line); m; m = INLINE_FIELD.exec(line)) {
		const open = line[m.index] as string;
		const close = open === "[" ? "]" : ")";
		let depth = 0;
		let end = line.length;
		for (let i = m.index; i < line.length; i++) {
			if (line[i] === open) depth++;
			else if (line[i] === close && --depth === 0) {
				end = i + 1;
				break;
			}
		}
		spans.push({ from: m.index, to: end, key: (m[1] as string).toLowerCase() });
	}
	const whole = LINE_FIELD.exec(line);
	if (whole && !spans.some((s) => s.from < whole[0].length)) spans.push({ from: whole[0].length, to: line.length, key: (whole[1] as string).toLowerCase() });
	return spans;
}
