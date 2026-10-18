import { DatabaseSync } from "node:sqlite";
import type { Section } from "./markdown.js";
import type { TypedLink } from "./relations.js";
import { sha256 } from "./util.js";

export const SCHEMA_VERSION = "3";

export interface NoteRecord {
	path: string;
	name: string;
	folder: string;
	title: string | null;
	description: string | null;
	aliases: string[];
	archived: boolean;
	supersededBy: string | null;
	attachment: string | null;
	blobHash: string;
	size: number;
	problems: string[];
}

export interface NoteRow extends NoteRecord {
	createdAt: string | null;
	createdBy: string | null;
	updatedAt: string | null;
	updatedBy: string | null;
}

export interface SectionRow {
	heading: string;
	level: number;
	lineStart: number;
	lineEnd: number;
}

export interface SearchHit {
	/** Row id of the section, to fuse text and vector results. */
	sectionId: number;
	path: string;
	name: string;
	description: string | null;
	section: SectionRow;
	snippet: string;
	score: number;
}

export interface LinkRow {
	srcPath: string;
	targetName: string;
	targetPath: string | null;
	heading: string | null;
	embed: boolean;
	relation: string | null;
	line: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  title TEXT,
  description TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL,
  superseded_by TEXT,
  attachment TEXT,
  blob_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT, created_by TEXT,
  updated_at TEXT, updated_by TEXT,
  problems TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS notes_name ON notes (name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS assets (path TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS assets_name ON assets (name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  ord INTEGER NOT NULL,
  heading TEXT NOT NULL,
  level INTEGER NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  embed_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sections_path ON sections (path);
CREATE INDEX IF NOT EXISTS sections_embed_hash ON sections (embed_hash);
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5 (
  title, aliases, description, heading, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS links (
  src_path TEXT NOT NULL,
  target_name TEXT NOT NULL,
  target_path TEXT,
  heading TEXT,
  embed INTEGER NOT NULL,
  relation TEXT,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_target ON links (target_path, relation);
CREATE INDEX IF NOT EXISTS links_target_name ON links (target_name);
CREATE INDEX IF NOT EXISTS links_src ON links (src_path);
CREATE TABLE IF NOT EXISTS vectors (hash TEXT PRIMARY KEY, vector BLOB NOT NULL);
`;

const TABLES = ["meta", "notes", "assets", "sections", "sections_fts", "links", "vectors"];

type Row = Record<string, unknown>;

function toNote(r: Row): NoteRow {
	return {
		path: r.path as string,
		name: r.name as string,
		folder: r.folder as string,
		title: (r.title as string | null) ?? null,
		description: (r.description as string | null) ?? null,
		aliases: JSON.parse(r.aliases as string) as string[],
		archived: r.archived === 1,
		supersededBy: (r.superseded_by as string | null) ?? null,
		attachment: (r.attachment as string | null) ?? null,
		blobHash: r.blob_hash as string,
		size: r.size as number,
		problems: JSON.parse(r.problems as string) as string[],
		createdAt: (r.created_at as string | null) ?? null,
		createdBy: (r.created_by as string | null) ?? null,
		updatedAt: (r.updated_at as string | null) ?? null,
		updatedBy: (r.updated_by as string | null) ?? null,
	};
}

/** The derived index: catalog, full text by section, and links. Everything here can be rebuilt from git. */
export class SearchIndex {
	readonly db: DatabaseSync;

	/**
	 * `readOnly` is for readers beside the server (`my-memory lint`): it never creates, migrates or resets the
	 * index, and refuses one made by another schema version instead of dropping the server's tables.
	 */
	constructor(path: string, opts: { readOnly?: boolean } = {}) {
		if (opts.readOnly) {
			try {
				this.db = new DatabaseSync(path, { readOnly: true });
			} catch (error) {
				throw new Error(`cannot open the index at ${path} (${(error as Error).message}): start the server once or run «my-memory reindex»`);
			}
			this.db.exec("PRAGMA busy_timeout = 5000;");
			let version: string | null = null;
			try {
				version = this.getMeta("schema_version");
			} catch {
				// No meta table: not an index, or an empty one.
			}
			if (version !== SCHEMA_VERSION) {
				this.db.close();
				throw new Error(
					`the index at ${path} has schema version ${version ?? "none"} and this my-memory expects ${SCHEMA_VERSION}; run the same version as the server (the server rebuilds the index when it starts with a new version)`,
				);
			}
			return;
		}
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
		// The version is checked before the rest of the schema: an older index may lack columns its indexes need.
		this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		if (this.getMeta("schema_version") !== SCHEMA_VERSION) this.reset();
		else this.db.exec(SCHEMA);
	}

	close(): void {
		if (this.db.isOpen) this.db.close();
	}

	/** Drops everything and recreates the schema; `indexed_commit` disappears, so the next reconcile is a full rebuild. */
	reset(): void {
		for (const t of TABLES) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
		this.db.exec(SCHEMA);
		this.setMeta("schema_version", SCHEMA_VERSION);
	}

	getMeta(key: string): string | null {
		const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
		return (r?.value as string | undefined) ?? null;
	}

	setMeta(key: string, value: string): void {
		this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	clearContent(): void {
		for (const t of ["notes", "assets", "sections", "sections_fts", "links"]) this.db.exec(`DELETE FROM ${t}`);
	}

	removeNote(path: string): void {
		this.db.prepare("DELETE FROM sections_fts WHERE rowid IN (SELECT id FROM sections WHERE path = ?)").run(path);
		this.db.prepare("DELETE FROM sections WHERE path = ?").run(path);
		this.db.prepare("DELETE FROM links WHERE src_path = ?").run(path);
		this.db.prepare("DELETE FROM notes WHERE path = ?").run(path);
	}

	putNote(note: NoteRecord, sections: Section[], links: TypedLink[]): void {
		const previous = this.db.prepare("SELECT created_at, created_by, updated_at, updated_by FROM notes WHERE path = ?").get(note.path) as Row | undefined;
		this.removeNote(note.path);
		this.db
			.prepare(
				`INSERT INTO notes (path, name, folder, title, description, aliases, archived, superseded_by, attachment, blob_hash, size, created_at, created_by, updated_at, updated_by, problems)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				note.path,
				note.name,
				note.folder,
				note.title,
				note.description,
				JSON.stringify(note.aliases),
				note.archived ? 1 : 0,
				note.supersededBy,
				note.attachment,
				note.blobHash,
				note.size,
				(previous?.created_at as string | null) ?? null,
				(previous?.created_by as string | null) ?? null,
				(previous?.updated_at as string | null) ?? null,
				(previous?.updated_by as string | null) ?? null,
				JSON.stringify(note.problems),
			);
		const insertSection = this.db.prepare("INSERT INTO sections (path, ord, heading, level, line_start, line_end, embed_hash) VALUES (?, ?, ?, ?, ?, ?, ?)");
		const insertFts = this.db.prepare("INSERT INTO sections_fts (rowid, title, aliases, description, heading, body) VALUES (?, ?, ?, ?, ?, ?)");
		const title = note.title ?? note.name;
		const aliases = note.aliases.join(" · ");
		sections.forEach((s, i) => {
			const first = i === 0;
			const embedHash = sha256(embeddingText({ title, aliases: first ? aliases : "", description: first ? (note.description ?? "") : "", heading: s.heading, body: s.text, first }));
			const { lastInsertRowid } = insertSection.run(note.path, i, s.heading, s.level, s.lineStart, s.lineEnd, embedHash);
			// Title, aliases and description go only with the first section, so a match on them points at the top of the note.
			insertFts.run(lastInsertRowid, first ? title : "", first ? aliases : "", first ? (note.description ?? "") : "", s.heading, s.text);
		});
		const insertLink = this.db.prepare("INSERT INTO links (src_path, target_name, target_path, heading, embed, relation, line) VALUES (?, ?, NULL, ?, ?, ?, ?)");
		for (const l of links) insertLink.run(note.path, l.targetName, l.heading, l.embed ? 1 : 0, l.relation, l.line);
	}

	setDates(path: string, dates: { createdAt?: string; createdBy?: string; updatedAt: string; updatedBy: string }): void {
		if (dates.createdAt) {
			this.db.prepare("UPDATE notes SET created_at = ?, created_by = ? WHERE path = ?").run(dates.createdAt, dates.createdBy ?? null, path);
		}
		this.db.prepare("UPDATE notes SET updated_at = ?, updated_by = ?, created_at = COALESCE(created_at, ?), created_by = COALESCE(created_by, ?) WHERE path = ?").run(dates.updatedAt, dates.updatedBy, dates.updatedAt, dates.updatedBy, path);
	}

	putAsset(path: string): void {
		this.db.prepare("INSERT OR REPLACE INTO assets (path, name) VALUES (?, ?)").run(path, (path.split("/").pop() as string).toLowerCase());
	}

	removeAsset(path: string): void {
		this.db.prepare("DELETE FROM assets WHERE path = ?").run(path);
	}

	/** Re-resolves every link: cheap at this scale and always right after adds, removes and renames. */
	resolveLinks(): void {
		this.db.exec(`
      UPDATE links SET target_path = COALESCE(
        (SELECT path FROM notes WHERE lower(notes.name) = links.target_name ORDER BY path LIMIT 1),
        (SELECT path FROM assets WHERE assets.name = links.target_name ORDER BY path LIMIT 1)
      )`);
	}

	getNote(path: string): NoteRow | null {
		const r = this.db.prepare("SELECT * FROM notes WHERE path = ?").get(path) as Row | undefined;
		return r ? toNote(r) : null;
	}

	notesByName(name: string): NoteRow[] {
		return (this.db.prepare("SELECT * FROM notes WHERE name = ? COLLATE NOCASE ORDER BY path").all(name) as Row[]).map(toNote);
	}

	assetByPath(path: string): boolean {
		return this.db.prepare("SELECT 1 FROM assets WHERE path = ?").get(path) !== undefined;
	}

	assetsByName(name: string): string[] {
		return (this.db.prepare("SELECT path FROM assets WHERE name = ? COLLATE NOCASE").all(name) as Row[]).map((r) => r.path as string);
	}

	allNotes(): NoteRow[] {
		return (this.db.prepare("SELECT * FROM notes ORDER BY path").all() as Row[]).map(toNote);
	}

	listNotes(opts: { folder?: string | null; includeArchive: boolean; limit: number; offset: number }): NoteRow[] {
		return (
			this.db
				.prepare("SELECT * FROM notes WHERE (?1 IS NULL OR folder = ?1) AND (?2 = 1 OR archived = 0) ORDER BY path LIMIT ?3 OFFSET ?4")
				.all(opts.folder ?? null, opts.includeArchive ? 1 : 0, opts.limit, opts.offset) as Row[]
		).map(toNote);
	}

	folderCounts(includeArchive: boolean): { folder: string; count: number }[] {
		return (this.db.prepare("SELECT folder, count(*) AS count FROM notes WHERE (?1 = 1 OR archived = 0) GROUP BY folder ORDER BY folder").all(includeArchive ? 1 : 0) as Row[]).map((r) => ({
			folder: r.folder as string,
			count: r.count as number,
		}));
	}

	sectionsOf(path: string): SectionRow[] {
		return (this.db.prepare("SELECT heading, level, line_start, line_end FROM sections WHERE path = ? ORDER BY ord").all(path) as Row[]).map((r) => ({
			heading: r.heading as string,
			level: r.level as number,
			lineStart: r.line_start as number,
			lineEnd: r.line_end as number,
		}));
	}

	search(match: string, opts: { folder?: string | null; includeArchive: boolean; limit: number }): SearchHit[] {
		const rows = this.db
			.prepare(
				`SELECT s.id, s.path, s.heading, s.level, s.line_start, s.line_end, n.name, n.description,
                bm25(sections_fts, 5.0, 4.0, 3.0, 2.0, 1.0) AS score,
                snippet(sections_fts, -1, '«', '»', '…', 24) AS snippet
         FROM sections_fts
         JOIN sections s ON s.id = sections_fts.rowid
         JOIN notes n ON n.path = s.path
         WHERE sections_fts MATCH ?1 AND (?2 IS NULL OR n.folder = ?2) AND (?3 = 1 OR n.archived = 0)
         ORDER BY score LIMIT ?4`,
			)
			.all(match, opts.folder ?? null, opts.includeArchive ? 1 : 0, opts.limit) as Row[];
		return rows.map((r) => ({
			sectionId: r.id as number,
			path: r.path as string,
			name: r.name as string,
			description: (r.description as string | null) ?? null,
			section: { heading: r.heading as string, level: r.level as number, lineStart: r.line_start as number, lineEnd: r.line_end as number },
			snippet: (r.snippet as string).replace(/\s+/g, " ").trim(),
			score: Math.round(-(r.score as number) * 1000) / 1000,
		}));
	}

	// ── vectors ─────────────────────────────────────────────────────────────
	// One vector per distinct section text, keyed by the hash of that text: a section that did not change keeps its
	// vector through edits of other sections, moves and full rebuilds, and two identical sections share one.

	/** Sections whose text has no vector yet, with the text to embed, at most `limit` distinct texts. */
	pendingEmbeddings(limit: number): { hash: string; text: string }[] {
		const rows = this.db
			.prepare(
				`SELECT s.embed_hash, s.ord, s.heading, f.aliases, f.description, f.body, COALESCE(n.title, n.name) AS title
         FROM sections s
         JOIN sections_fts f ON f.rowid = s.id
         JOIN notes n ON n.path = s.path
         WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.hash = s.embed_hash)
         GROUP BY s.embed_hash ORDER BY min(s.id) LIMIT ?`,
			)
			.all(limit) as Row[];
		return rows.map((r) => ({
			hash: r.embed_hash as string,
			text: embeddingText({ title: r.title as string, aliases: r.aliases as string, description: r.description as string, heading: r.heading as string, body: r.body as string, first: r.ord === 0 }),
		}));
	}

	pendingEmbeddingCount(): number {
		return (this.db.prepare("SELECT count(DISTINCT embed_hash) AS c FROM sections s WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.hash = s.embed_hash)").get() as Row).c as number;
	}

	vectorCount(): number {
		return (this.db.prepare("SELECT count(*) AS c FROM vectors").get() as Row).c as number;
	}

	putVector(hash: string, vector: Float32Array): void {
		this.db.prepare("INSERT OR REPLACE INTO vectors (hash, vector) VALUES (?, ?)").run(hash, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
	}

	clearVectors(): void {
		this.db.exec("DELETE FROM vectors");
	}

	/** Forgets the vectors of texts no section has any more. */
	pruneVectors(): void {
		this.db.exec("DELETE FROM vectors WHERE hash NOT IN (SELECT embed_hash FROM sections)");
	}

	/** Every section that has a vector, within the folder and archive filters. Brute force: fine for a few thousand. */
	sectionVectors(opts: { folder?: string | null; includeArchive: boolean }): { sectionId: number; vector: Float32Array }[] {
		const rows = this.db
			.prepare(
				`SELECT s.id, v.vector FROM sections s
         JOIN vectors v ON v.hash = s.embed_hash
         JOIN notes n ON n.path = s.path
         WHERE (?1 IS NULL OR n.folder = ?1) AND (?2 = 1 OR n.archived = 0)`,
			)
			.all(opts.folder ?? null, opts.includeArchive ? 1 : 0) as Row[];
		return rows.map((r) => {
			const blob = r.vector as Uint8Array;
			// Float32Array needs a 4-byte aligned offset; copy when the blob does not have one.
			const bytes = blob.byteOffset % 4 === 0 ? blob : blob.slice();
			return { sectionId: r.id as number, vector: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) };
		});
	}

	/** A section as a search hit, for sections found by vector only: the snippet is the start of its text. */
	sectionHit(id: number, score: number): SearchHit | null {
		const r = this.db
			.prepare(
				`SELECT s.id, s.path, s.heading, s.level, s.line_start, s.line_end, n.name, n.description, f.body
         FROM sections s JOIN notes n ON n.path = s.path JOIN sections_fts f ON f.rowid = s.id WHERE s.id = ?`,
			)
			.get(id) as Row | undefined;
		if (!r) return null;
		const words = (r.body as string).replace(/\s+/g, " ").trim().split(" ");
		return {
			sectionId: r.id as number,
			path: r.path as string,
			name: r.name as string,
			description: (r.description as string | null) ?? null,
			section: { heading: r.heading as string, level: r.level as number, lineStart: r.line_start as number, lineEnd: r.line_end as number },
			snippet: words.length > 24 ? `${words.slice(0, 24).join(" ")}…` : words.join(" "),
			score,
		};
	}

	/** Links from a note, optionally only those of one relation. */
	linksOut(path: string, relation?: string): LinkRow[] {
		return (this.db.prepare("SELECT * FROM links WHERE src_path = ?1 AND (?2 IS NULL OR relation = ?2) ORDER BY line").all(path, relation ?? null) as Row[]).map(toLink);
	}

	/** Links to a note or asset, optionally only those of one relation. */
	linksIn(path: string, relation?: string): LinkRow[] {
		return (this.db.prepare("SELECT * FROM links WHERE target_path = ?1 AND (?2 IS NULL OR relation = ?2) ORDER BY src_path, line").all(path, relation ?? null) as Row[]).map(toLink);
	}

	/** Every relation key in use, with how many links carry it. */
	relations(): { relation: string; count: number }[] {
		return (this.db.prepare("SELECT relation, count(*) AS count FROM links WHERE relation IS NOT NULL GROUP BY relation ORDER BY relation").all() as Row[]).map((r) => ({
			relation: r.relation as string,
			count: r.count as number,
		}));
	}

	allLinks(): LinkRow[] {
		return (this.db.prepare("SELECT * FROM links ORDER BY src_path, line").all() as Row[]).map(toLink);
	}

	/** Every section with its indexed body text (the FTS table keeps it), in note order. For lint. */
	sectionTexts(): { path: string; heading: string; lineStart: number; text: string }[] {
		return (
			this.db.prepare("SELECT s.path, s.heading, s.line_start, f.body FROM sections s JOIN sections_fts f ON f.rowid = s.id ORDER BY s.path, s.ord").all() as Row[]
		).map((r) => ({ path: r.path as string, heading: r.heading as string, lineStart: r.line_start as number, text: r.body as string }));
	}

	/** Number of sections per note. */
	sectionCounts(): Map<string, number> {
		return new Map((this.db.prepare("SELECT path, count(*) AS c FROM sections GROUP BY path").all() as Row[]).map((r) => [r.path as string, r.c as number]));
	}

	brokenLinks(): LinkRow[] {
		return (this.db.prepare("SELECT * FROM links WHERE target_path IS NULL ORDER BY src_path, line").all() as Row[]).map(toLink);
	}

	counts(): { notes: number; sections: number; links: number; assets: number } {
		const c = (t: string) => (this.db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as Row).c as number;
		return { notes: c("notes"), sections: c("sections"), links: c("links"), assets: c("assets") };
	}
}

function toLink(r: Row): LinkRow {
	return {
		srcPath: r.src_path as string,
		targetName: r.target_name as string,
		targetPath: (r.target_path as string | null) ?? null,
		heading: (r.heading as string | null) ?? null,
		embed: r.embed === 1,
		relation: (r.relation as string | null) ?? null,
		line: r.line as number,
	};
}

/**
 * The text a section is embedded from: the note's title and, for the first section, its aliases and description,
 * so a vector carries the same context the full-text columns give that section.
 */
export function embeddingText(s: { title: string; aliases: string; description: string; heading: string; body: string; first: boolean }): string {
	const head = s.first ? [s.title, s.aliases, s.description, s.heading === s.title ? "" : s.heading] : [`${s.title} › ${s.heading}`];
	return [...head.filter(Boolean), s.body.trim()].join("\n");
}

/**
 * Turns free text into a safe FTS5 query: quoted phrases stay phrases, every other word of 3+ characters
 * becomes a prefix term (Spanish has no stemmer here). Returns an AND query and an OR fallback, or null if empty.
 */
export function buildFtsQuery(input: string): { and: string; or: string } | null {
	const terms: string[] = [];
	const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
	const rest = input.replace(/"([^"]*)"/g, (_, phrase: string) => {
		const words = phrase.match(/[\p{L}\p{N}]+/gu);
		if (words?.length) terms.push(quote(words.join(" ")));
		return " ";
	});
	for (const word of rest.match(/[\p{L}\p{N}]+/gu) ?? []) {
		terms.push(word.length >= 3 ? `${quote(word)}*` : quote(word));
	}
	if (terms.length === 0) return null;
	return { and: terms.join(" AND "), or: terms.join(" OR ") };
}
