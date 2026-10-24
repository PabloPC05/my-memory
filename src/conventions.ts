import { parse as parseToml } from "smol-toml";
import { RELATION_KEY } from "./relations.js";

/** The rules a notes repo declares in its `memory.toml`. The server only ships defaults. */
export interface Conventions {
	folders: {
		/** Writable top-level folders; `null` means any folder. */
		allowed: string[] | null;
		/** Folder excluded from `list` and `search` unless asked; `null` for none. */
		archive: string | null;
		/** Folders listed note by note in the short index. */
		indexFull: string[];
		/** Files at the repo root that tools may read and edit. */
		rootFiles: string[];
	};
	notes: {
		requiredFields: string[];
		/** Applies to new names only (create, move, attach). */
		filenamePattern: RegExp;
		supersededField: string;
		maxDescription: number;
	};
	instructions: {
		/** File sent as MCP instructions, relative to the repo root; `null` for none. */
		file: string | null;
	};
	attachments: {
		/** Heading of each extracted page in a companion note; `{n}` is the page number. */
		pageHeading: string;
		/** Line put in a companion note whose text comes from OCR; `{languages}` is replaced. */
		ocrNotice: string;
	};
	relations: {
		/** Relation keys agents may use in `key:: [[x]]`, lowercase; `null` means any. */
		allowed: string[] | null;
	};
	resume: {
		/** Headings of a note's state sections (what is going on, what comes next), returned whole by `resume`. */
		sections: string[];
		/** At most this many characters of state sections in one answer. */
		maxChars: number;
	};
	lint: {
		/** Folders left out of every lint check (the archive and root files always are). */
		exclude: string[];
		/** Folders whose notes are not reported as orphans; defaults to `folders.index_full`. */
		orphanExclude: string[];
		/** A note unchanged for more days than this is `stale`. */
		staleDays: number;
		/** An inference marker older than this many days is `old_inference`. */
		inferenceDays: number;
		/** Words of the provenance marker that flags an inference: `(deducido)` or `(deducido, 2026-01-31)`. */
		inferredMarkers: string[];
		/** Notes larger than this many bytes are `oversized` (attachment companions are exempt). */
		maxBytes: number;
		/** A missing target linked from at least this many notes is a `missing_page` rather than a `broken_link`. */
		missingPageMin: number;
		/** Shortest label (normalized characters) looked for as an `unlinked_mention`. */
		mentionMinLength: number;
	};
}

export const CONVENTIONS_FILE = "memory.toml";

export function defaultConventions(): Conventions {
	return {
		folders: { allowed: null, archive: "archive", indexFull: [], rootFiles: ["AGENTS.md", "README.md"] },
		notes: {
			requiredFields: ["name", "description"],
			filenamePattern: /^[a-z0-9]+(-[a-z0-9]+)*\.md$/,
			supersededField: "superseded_by",
			maxDescription: 200,
		},
		instructions: { file: "AGENTS.md" },
		attachments: { pageHeading: "Page {n}", ocrNotice: "Text recognised with OCR ({languages}); it may contain errors." },
		relations: { allowed: null },
		resume: { sections: ["Status", "In progress", "Next steps", "Open questions"], maxChars: 6000 },
		lint: { exclude: [], orphanExclude: [], staleDays: 180, inferenceDays: 90, inferredMarkers: ["deducido"], maxBytes: 16_384, missingPageMin: 2, mentionMinLength: 4 },
	};
}

const FOLDER = /^[^/\\.][^/\\]*$/;

function stringList(value: unknown, key: string, check?: (v: string) => boolean): string[] {
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0)) throw new Error(`${key} must be a list of non-empty strings`);
	if (check) for (const v of value) if (!check(v)) throw new Error(`${key}: invalid entry «${v}»`);
	return value as string[];
}

function table(value: unknown, key: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`[${key}] must be a table`);
	return value as Record<string, unknown>;
}

/** Parses `memory.toml`. Throws with a readable message when the file is invalid; the caller keeps the last valid one. */
export function parseConventions(text: string): Conventions {
	const doc = parseToml(text) as Record<string, unknown>;
	const c = defaultConventions();
	const folders = table(doc.folders, "folders");
	if (folders.allowed !== undefined) c.folders.allowed = stringList(folders.allowed, "folders.allowed", (v) => FOLDER.test(v));
	if (folders.archive !== undefined) {
		if (folders.archive === false || folders.archive === "") c.folders.archive = null;
		else if (typeof folders.archive === "string" && FOLDER.test(folders.archive)) c.folders.archive = folders.archive;
		else throw new Error("folders.archive must be a folder name");
	}
	if (folders.index_full !== undefined) c.folders.indexFull = stringList(folders.index_full, "folders.index_full", (v) => FOLDER.test(v));
	if (folders.root_files !== undefined) c.folders.rootFiles = stringList(folders.root_files, "folders.root_files", (v) => FOLDER.test(v) && v.endsWith(".md"));

	const notes = table(doc.notes, "notes");
	if (notes.required_fields !== undefined) c.notes.requiredFields = stringList(notes.required_fields, "notes.required_fields");
	if (notes.filename_pattern !== undefined) {
		if (typeof notes.filename_pattern !== "string") throw new Error("notes.filename_pattern must be a string");
		try {
			c.notes.filenamePattern = new RegExp(notes.filename_pattern, "u");
		} catch (error) {
			throw new Error(`notes.filename_pattern is not a valid regular expression: ${(error as Error).message}`);
		}
	}
	if (notes.superseded_field !== undefined) {
		if (typeof notes.superseded_field !== "string" || !/^[A-Za-z_][\w-]*$/.test(notes.superseded_field)) throw new Error("notes.superseded_field must be a field name");
		c.notes.supersededField = notes.superseded_field;
	}
	if (notes.max_description !== undefined) {
		if (typeof notes.max_description !== "number" || !Number.isInteger(notes.max_description) || notes.max_description < 1) throw new Error("notes.max_description must be a positive integer");
		c.notes.maxDescription = notes.max_description;
	}

	const instructions = table(doc.instructions, "instructions");
	if (instructions.file !== undefined) {
		if (instructions.file === false || instructions.file === "") c.instructions.file = null;
		else if (typeof instructions.file === "string" && !instructions.file.includes("..")) c.instructions.file = instructions.file;
		else throw new Error("instructions.file must be a path inside the repo");
	}

	const attachments = table(doc.attachments, "attachments");
	if (attachments.page_heading !== undefined) {
		if (typeof attachments.page_heading !== "string" || !attachments.page_heading.includes("{n}")) throw new Error("attachments.page_heading must be a string containing {n}");
		c.attachments.pageHeading = attachments.page_heading;
	}
	if (attachments.ocr_notice !== undefined) {
		if (typeof attachments.ocr_notice !== "string" || !attachments.ocr_notice.trim()) throw new Error("attachments.ocr_notice must be a non-empty string");
		c.attachments.ocrNotice = attachments.ocr_notice.trim();
	}

	const relations = table(doc.relations, "relations");
	if (relations.allowed !== undefined) c.relations.allowed = stringList(relations.allowed, "relations.allowed", (v) => RELATION_KEY.test(v)).map((v) => v.toLowerCase());

	const resume = table(doc.resume, "resume");
	if (resume.sections !== undefined) c.resume.sections = stringList(resume.sections, "resume.sections", (v) => v.trim() !== "");
	if (resume.max_chars !== undefined) {
		if (typeof resume.max_chars !== "number" || !Number.isInteger(resume.max_chars) || resume.max_chars < 500) throw new Error("resume.max_chars must be an integer >= 500");
		c.resume.maxChars = resume.max_chars;
	}

	const lint = table(doc.lint, "lint");
	if (lint.exclude !== undefined) c.lint.exclude = stringList(lint.exclude, "lint.exclude", (v) => FOLDER.test(v));
	c.lint.orphanExclude = lint.orphan_exclude !== undefined ? stringList(lint.orphan_exclude, "lint.orphan_exclude", (v) => FOLDER.test(v)) : c.folders.indexFull;
	if (lint.inferred_markers !== undefined) c.lint.inferredMarkers = stringList(lint.inferred_markers, "lint.inferred_markers", (v) => /^[\p{L}\p{N} _-]+$/u.test(v));
	const positive = (key: string, value: unknown): number => {
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`lint.${key} must be a positive integer`);
		return value;
	};
	if (lint.stale_days !== undefined) c.lint.staleDays = positive("stale_days", lint.stale_days);
	if (lint.inference_days !== undefined) c.lint.inferenceDays = positive("inference_days", lint.inference_days);
	if (lint.max_bytes !== undefined) c.lint.maxBytes = positive("max_bytes", lint.max_bytes);
	if (lint.missing_page_min !== undefined) c.lint.missingPageMin = positive("missing_page_min", lint.missing_page_min);
	if (lint.mention_min_length !== undefined) c.lint.mentionMinLength = positive("mention_min_length", lint.mention_min_length);
	return c;
}
