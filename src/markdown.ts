/**
 * Markdown helpers that respect code: headings and links inside fenced blocks or inline code spans are not real.
 * Every function works on positions of the original text, so rewrites only touch the link spans.
 */

/** Same text with fenced code blocks and inline code replaced by spaces (newlines kept), so offsets stay valid. */
export function maskCode(text: string): string {
	const out = text.split("");
	const blank = (from: number, to: number) => {
		for (let i = from; i < to; i++) if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
	};
	// Fenced blocks, line by line.
	let offset = 0;
	let fence: { char: string; len: number } | null = null;
	let fenceStart = 0;
	const lines = text.split("\n");
	const inFence: boolean[] = [];
	for (const line of lines) {
		const lineEnd = offset + line.length;
		const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (fence === null) {
			if (m?.[1]) {
				fence = { char: m[1][0] as string, len: m[1].length };
				fenceStart = offset;
				inFence.push(true);
			} else inFence.push(false);
		} else {
			inFence.push(true);
			const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
			if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.len) {
				blank(fenceStart, lineEnd);
				fence = null;
			}
		}
		offset = lineEnd + 1;
	}
	if (fence !== null) blank(fenceStart, text.length);
	// Inline code spans outside fences: a run of N backticks closed by a run of exactly N.
	const masked = out.join("");
	const re = /(`+)([\s\S]*?[^`])\1(?!`)/g;
	let lineStarts: number[] | null = null;
	for (let m = re.exec(masked); m; m = re.exec(masked)) {
		if (m[0].includes("\n\n")) {
			re.lastIndex = m.index + m[1]!.length;
			continue;
		}
		lineStarts ??= lineOffsets(text);
		const line = lineAt(lineStarts, m.index);
		if (inFence[line]) continue;
		blank(m.index, m.index + m[0].length);
	}
	return out.join("");
}

export function lineOffsets(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	return starts;
}

/** 0-based line index of an offset. */
export function lineAt(starts: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((starts[mid] as number) <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

export interface Section {
	heading: string;
	level: number;
	/** 1-based, inclusive, relative to the whole file. */
	lineStart: number;
	lineEnd: number;
	text: string;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/;

/**
 * Splits a note body into sections: the text before the first `##` is one section named after the title,
 * then every `##` or `###` starts a new one. Deeper headings stay inside their parent.
 */
export function splitSections(body: string, bodyLine: number, title: string): Section[] {
	const lines = body.split("\n");
	const masked = maskCode(body).split("\n");
	const sections: Section[] = [];
	let current: { heading: string; level: number; start: number } = { heading: title, level: 1, start: 0 };
	const close = (endExclusive: number) => {
		const text = `${lines.slice(current.start, endExclusive).join("\n").replace(/\r/g, "").trimEnd()}\n`;
		sections.push({ heading: current.heading, level: current.level, lineStart: bodyLine + current.start, lineEnd: bodyLine + Math.max(current.start, endExclusive - 1), text });
	};
	for (let i = 0; i < masked.length; i++) {
		const m = HEADING.exec(masked[i] as string);
		if (!m) continue;
		const level = (m[1] as string).length;
		if (level !== 2 && level !== 3) continue;
		close(i);
		current = { heading: (HEADING.exec((lines[i] as string).replace(/\r$/, ""))?.[2] ?? (m[2] as string)).trim(), level, start: i };
	}
	close(lines.length);
	return sections;
}

/** First `# Heading` of the body, if any. */
export function firstH1(body: string): string | null {
	for (const line of maskCode(body).split("\n")) {
		const m = HEADING.exec(line);
		if (m && m[1] === "#") return (m[2] as string).trim() || null;
	}
	return null;
}

export interface WikiLink {
	/** Offsets of the whole `[[...]]` (with the `!` for embeds) in the text. */
	start: number;
	end: number;
	embed: boolean;
	/** Target as written, without heading or alias: `notes/x`, `x.md`, `file.pdf`. */
	rawTarget: string;
	/** Lowercased basename used to resolve the link; `.md` dropped, other extensions kept. */
	targetName: string;
	heading: string | null;
	/** Everything from the alias separator on (`|text` or `\|text`), kept verbatim on rewrites. */
	aliasPart: string;
	alias: string | null;
	/** 1-based line. */
	line: number;
}

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;

export function targetNameOf(rawTarget: string): string {
	const base = rawTarget.trim().split("/").pop() ?? "";
	return base.replace(/\.md$/i, "").toLowerCase();
}

export function parseWikiLinks(text: string): WikiLink[] {
	const masked = maskCode(text);
	const starts = lineOffsets(text);
	const links: WikiLink[] = [];
	WIKILINK.lastIndex = 0;
	for (let m = WIKILINK.exec(masked); m; m = WIKILINK.exec(masked)) {
		const start = m.index;
		const end = start + m[0].length;
		const inner = text.slice(start + m[1]!.length + 2, end - 2);
		const pipe = inner.indexOf("|");
		let target = inner;
		let aliasPart = "";
		if (pipe >= 0) {
			const escaped = pipe > 0 && inner[pipe - 1] === "\\";
			target = inner.slice(0, escaped ? pipe - 1 : pipe);
			aliasPart = inner.slice(escaped ? pipe - 1 : pipe);
		}
		const hash = target.indexOf("#");
		const rawTarget = (hash >= 0 ? target.slice(0, hash) : target).trim();
		const heading = hash >= 0 ? target.slice(hash + 1).trim() || null : null;
		if (rawTarget === "") continue; // [[#Heading]] points inside the same note
		links.push({
			start,
			end,
			embed: m[1] === "!",
			rawTarget,
			targetName: targetNameOf(rawTarget),
			heading,
			aliasPart,
			alias: aliasPart ? aliasPart.replace(/^\\?\|/, "") : null,
			line: lineAt(starts, start) + 1,
		});
	}
	return links;
}

/**
 * Rewrites wikilink targets. `rename` gets each link and returns the new target (without heading or alias),
 * or `null` to leave it as it is. Headings, aliases and the embed mark are kept.
 */
export function rewriteWikiLinks(text: string, rename: (link: WikiLink) => string | null): { text: string; count: number } {
	const links = parseWikiLinks(text);
	let out = "";
	let last = 0;
	let count = 0;
	for (const link of links) {
		const target = rename(link);
		if (target === null) continue;
		out += text.slice(last, link.start);
		out += `${link.embed ? "!" : ""}[[${target}${link.heading ? `#${link.heading}` : ""}${link.aliasPart}]]`;
		last = link.end;
		count++;
	}
	return { text: out + text.slice(last), count };
}
