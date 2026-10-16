import { parse as parseYaml } from "yaml";
import type { Conventions } from "./conventions.js";

export interface SplitNote {
	/** Raw YAML between the `---` lines, or `null` when the note has no frontmatter. */
	yaml: string | null;
	body: string;
	/** 1-based line of the file where `body` starts. */
	bodyLine: number;
}

/** Frontmatter between two `---` lines at the very start of the file (an optional BOM before it). */
const FRONTMATTER = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(text: string): SplitNote {
	const match = FRONTMATTER.exec(text);
	if (!match) return { yaml: null, body: text.replace(/^﻿/, ""), bodyLine: 1 };
	const consumed = match[0];
	return { yaml: match[1] ?? "", body: text.slice(consumed.length), bodyLine: 1 + (consumed.match(/\n/g)?.length ?? 0) };
}

export interface NoteMeta {
	fields: Record<string, unknown>;
	title: string | null;
	description: string | null;
	aliases: string[];
	superseded: string | null;
	attachment: string | null;
}

export interface ParsedNote extends SplitNote {
	meta: NoteMeta;
	/** Problems found reading the frontmatter, as short human-readable strings. */
	problems: string[];
}

function str(value: unknown): string | null {
	if (typeof value === "string") return value.trim() || null;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

/** Strips `[[...]]` so `sustituida_por: "[[x]]"` gives `x`. */
export function linkTargetName(value: string): string {
	const m = /^\s*!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]\s*$/.exec(value);
	return (m?.[1] ?? value).trim().replace(/\.md$/i, "");
}

function unquote(v: string): string {
	const t = v.trim();
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
	if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
	return t;
}

/**
 * Line-based reading of frontmatter that strict YAML rejects, typically `description: a: b` without quotes.
 * Understands `key: value` (the rest of the line), flow lists, block lists and `>`/`|` blocks. Not a YAML parser.
 */
export function lenientYaml(yaml: string): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	let key: string | null = null;
	let block: string[] | null = null;
	let list: string[] | null = null;
	const flush = () => {
		if (key && block) fields[key] = block.join(" ").trim();
		if (key && list) fields[key] = list;
		block = null;
		list = null;
	};
	for (const line of yaml.split(/\r?\n/)) {
		const kv = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(line);
		if (kv) {
			flush();
			key = kv[1] as string;
			const value = (kv[2] ?? "").trim();
			if (/^[>|][+-]?$/.test(value)) block = [];
			else if (value === "") list = [];
			else if (value.startsWith("[") && value.endsWith("]")) fields[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
			else fields[key] = unquote(value);
			continue;
		}
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && list) list.push(unquote(item[1] as string));
		else if (block && /^\s+\S/.test(line)) (block as string[]).push(line.trim());
	}
	flush();
	for (const [k, v] of Object.entries(fields)) if (Array.isArray(v) && v.length === 0) fields[k] = null;
	return fields;
}

export function parseNote(text: string, conventions: Conventions): ParsedNote {
	const split = splitFrontmatter(text);
	const problems: string[] = [];
	let fields: Record<string, unknown> = {};
	if (split.yaml === null) {
		if (conventions.notes.requiredFields.length > 0) problems.push("missing frontmatter");
	} else {
		try {
			const doc: unknown = split.yaml.trim() === "" ? {} : parseYaml(split.yaml, { schema: "core", uniqueKeys: true });
			if (doc === null || doc === undefined) fields = {};
			else if (typeof doc === "object" && !Array.isArray(doc)) fields = doc as Record<string, unknown>;
			else problems.push("frontmatter is not a mapping");
		} catch (error) {
			problems.push(`frontmatter is not valid YAML (quote values that contain «: »): ${(error as Error).message.split("\n")[0]?.replace(/:$/, "")}`);
			fields = lenientYaml(split.yaml);
		}
	}
	for (const key of conventions.notes.requiredFields) {
		if (str(fields[key]) === null) problems.push(`missing required field «${key}»`);
	}
	const description = str(fields.description);
	if (description !== null) {
		if (/[\r\n]/.test(description)) problems.push("«description» must be a single line");
		if (description.length > conventions.notes.maxDescription) problems.push(`«description» is longer than ${conventions.notes.maxDescription} characters`);
	}
	let aliases: string[] = [];
	const rawAliases = fields.aliases;
	if (Array.isArray(rawAliases)) {
		if (rawAliases.every((a) => str(a) !== null)) aliases = rawAliases.map((a) => str(a) as string);
		else problems.push("«aliases» must be a list of strings");
	} else if (rawAliases !== undefined && rawAliases !== null) {
		const single = str(rawAliases);
		if (single === null) problems.push("«aliases» must be a list of strings");
		else aliases = [single];
	}
	const supersededRaw = fields[conventions.notes.supersededField];
	let superseded: string | null = null;
	if (supersededRaw !== undefined && supersededRaw !== null) {
		const s = str(supersededRaw);
		if (s === null) problems.push(`«${conventions.notes.supersededField}» must be a string`);
		else superseded = linkTargetName(s);
	}
	return {
		...split,
		meta: { fields, title: str(fields.name), description, aliases, superseded, attachment: str(fields.attachment) },
		problems,
	};
}
