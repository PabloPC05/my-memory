import { gunzipSync, gzipSync } from "node:zlib";
import { type DriveClient, DriveError } from "./drive.js";
import { type Logger, silentLogger } from "./log.js";

const FIELDS = "id,name,mimeType,parents,modifiedTime,size,md5Checksum,trashed,webViewLink";
export const FOLDER = "application/vnd.google-apps.folder";
const SNAPSHOT = "my-memory-drive-index.json.gz";
const SNAPSHOT_EVERY_MS = 60_000;

/** One file or folder of the user's Drive, as the index keeps it. */
export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	parents: string[];
	modifiedTime: string;
	size: number | null;
	md5: string | null;
	link: string | null;
}

/** What the files tools return for a file. */
export interface FileHit {
	id: string;
	name: string;
	path: string;
	folder: boolean;
	mime_type: string;
	modified: string;
	size: number | null;
	link: string | null;
}

export type FileContent = { kind: "text"; text: string; mimeType: string; truncated: boolean } | { kind: "binary"; data: Buffer; mimeType: string; name: string };

type ApiFile = { id: string; name: string; mimeType: string; parents?: string[]; modifiedTime?: string; size?: string; md5Checksum?: string; trashed?: boolean; webViewLink?: string };

/** Google's own formats, read as text through their export. */
const EXPORTS: Record<string, string> = {
	"application/vnd.google-apps.document": "text/plain",
	"application/vnd.google-apps.spreadsheet": "text/csv",
	"application/vnd.google-apps.presentation": "text/plain",
};
const isText = (mime: string) => mime.startsWith("text/") || /^application\/(json|xml|x-yaml|yaml|csv|x-ndjson|javascript|x-sh)$/.test(mime);
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function toFile(f: ApiFile): DriveFile {
	return {
		id: f.id,
		name: f.name,
		mimeType: f.mimeType,
		parents: f.parents ?? [],
		modifiedTime: f.modifiedTime ?? "",
		size: f.size ? Number(f.size) : null,
		md5: f.md5Checksum ?? null,
		link: f.webViewLink ?? null,
	};
}

/**
 * An index of the user's whole Drive ("My Drive"), in memory, like FSearch or Everything: the list of every file
 * with its path is read once and then kept current with Drive's changes feed, so searching by name never asks
 * Drive and takes milliseconds. Searching inside files uses Drive's own full-text index (PDFs, documents and OCR'd
 * images included), so nothing is downloaded to search.
 *
 * A snapshot of the index (and the changes token) lives in the app's hidden folder in Drive (appDataFolder), so a
 * serverless cold start reads one small file instead of listing the whole Drive. Without the drive.appdata scope
 * that is skipped and a cold start lists everything again.
 */
export class DriveFiles {
	private files = new Map<string, DriveFile>();
	private rootId: string | null = null;
	private pageToken: string | null = null;
	private paths = new Map<string, string | null>();
	private entries: { id: string; name: string; path: string }[] | null = null;
	private lastRefresh = 0;
	private refreshing: Promise<string[]> | null = null;
	private snapshotId: string | null = null;
	private snapshotOff = false;
	private savedAt = 0;
	private dirty = false;
	private readonly listeners = new Set<(ids: string[]) => void>();
	private readonly log: Logger;

	constructor(
		readonly drive: DriveClient,
		opts: { log?: Logger; snapshot?: boolean } = {},
	) {
		this.log = opts.log ?? silentLogger;
		this.snapshotOff = opts.snapshot === false;
	}

	/** Called with the ids of the files that changed (added, edited, moved or removed) after each refresh. */
	onChange(fn: (ids: string[]) => void): void {
		this.listeners.add(fn);
	}

	get size(): number {
		return this.files.size;
	}

	async start(): Promise<void> {
		if (!(await this.loadSnapshot())) await this.listAll();
		await this.refresh();
	}

	// ── snapshot ─────────────────────────────────────────────────────────────

	private async loadSnapshot(): Promise<boolean> {
		if (this.snapshotOff) return false;
		try {
			const list = await this.drive.json<{ files: { id: string }[] }>("GET", "/drive/v3/files", { query: { spaces: "appDataFolder", q: `name = '${SNAPSHOT}'`, fields: "files(id)" } });
			this.snapshotId = list.files[0]?.id ?? null;
			if (!this.snapshotId) return false;
			const gz = await this.drive.bytes(`/drive/v3/files/${this.snapshotId}`, { alt: "media" });
			if (!gz) return false;
			const s = JSON.parse(gunzipSync(gz).toString("utf8")) as { v: number; rootId: string; pageToken: string; files: DriveFile[] };
			if (s.v !== 1 || !s.pageToken) return false;
			this.rootId = s.rootId;
			this.pageToken = s.pageToken;
			this.files = new Map(s.files.map((f) => [f.id, f]));
			this.invalidate();
			this.savedAt = Date.now();
			this.log("info", "drive.snapshot_loaded", { files: this.files.size });
			return true;
		} catch (error) {
			if (error instanceof DriveError && (error.status === 403 || error.status === 401)) {
				this.snapshotOff = true;
				this.log("warn", "drive.snapshot_unavailable", { reason: "no drive.appdata scope: every cold start lists the whole Drive" });
			} else this.log("warn", "drive.snapshot_failed", { error: (error as Error).message });
			return false;
		}
	}

	private async saveSnapshot(force = false): Promise<void> {
		if (this.snapshotOff || !this.dirty || !this.pageToken) return;
		if (!force && Date.now() - this.savedAt < SNAPSHOT_EVERY_MS) return;
		const body = gzipSync(Buffer.from(JSON.stringify({ v: 1, rootId: this.rootId, pageToken: this.pageToken, files: [...this.files.values()] })));
		try {
			if (this.snapshotId) {
				const r = await this.drive.request("PATCH", `/upload/drive/v3/files/${this.snapshotId}`, { query: { uploadType: "media" }, body, contentType: "application/gzip" });
				if (!r.ok) throw new DriveError(r.status, `snapshot update: ${r.status}`);
			} else {
				const boundary = `mm${Date.now().toString(36)}`;
				const meta = JSON.stringify({ name: SNAPSHOT, parents: ["appDataFolder"] });
				const multipart = Buffer.concat([
					Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`),
					body,
					Buffer.from(`\r\n--${boundary}--`),
				]);
				const r = await this.drive.request("POST", "/upload/drive/v3/files", { query: { uploadType: "multipart", fields: "id" }, body: multipart, contentType: `multipart/related; boundary=${boundary}` });
				if (!r.ok) throw new DriveError(r.status, `snapshot create: ${r.status}`);
				this.snapshotId = ((await r.json()) as { id: string }).id;
			}
			this.savedAt = Date.now();
			this.dirty = false;
		} catch (error) {
			if (error instanceof DriveError && (error.status === 403 || error.status === 401)) this.snapshotOff = true;
			this.log("warn", "drive.snapshot_save_failed", { error: (error as Error).message });
		}
	}

	// ── listing and changes ──────────────────────────────────────────────────

	private invalidate(): void {
		this.paths.clear();
		this.entries = null;
	}

	private async listAll(): Promise<void> {
		const started = Date.now();
		this.rootId = (await this.drive.json<{ id: string }>("GET", "/drive/v3/files/root", { query: { fields: "id" } })).id;
		// The token first: whatever changes while listing comes in with the next refresh.
		this.pageToken = (await this.drive.json<{ startPageToken: string }>("GET", "/drive/v3/changes/startPageToken")).startPageToken;
		const files = new Map<string, DriveFile>();
		let page: string | undefined;
		do {
			const r = await this.drive.json<{ files: ApiFile[]; nextPageToken?: string }>("GET", "/drive/v3/files", {
				query: { q: "trashed = false", pageSize: 1000, pageToken: page, fields: `nextPageToken,files(${FIELDS})`, spaces: "drive" },
			});
			for (const f of r.files) files.set(f.id, toFile(f));
			page = r.nextPageToken;
		} while (page);
		this.files = files;
		this.invalidate();
		this.dirty = true;
		this.lastRefresh = Date.now();
		this.log("info", "drive.listed", { files: files.size, ms: Date.now() - started });
		await this.saveSnapshot(true);
	}

	/** Applies Drive's changes since the last time. Returns the ids that changed. */
	refresh(): Promise<string[]> {
		this.refreshing ??= (async () => {
			if (!this.pageToken) return [];
			const changed: string[] = [];
			let token: string | undefined = this.pageToken;
			while (token) {
				const r: { changes: { fileId: string; removed?: boolean; file?: ApiFile }[]; nextPageToken?: string; newStartPageToken?: string } = await this.drive.json("GET", "/drive/v3/changes", {
					query: { pageToken: token, pageSize: 1000, includeRemoved: true, spaces: "drive", fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))` },
				});
				for (const c of r.changes) {
					if (c.removed || !c.file || c.file.trashed) this.files.delete(c.fileId);
					else this.files.set(c.fileId, toFile(c.file));
					changed.push(c.fileId);
				}
				if (r.newStartPageToken) {
					this.pageToken = r.newStartPageToken;
					token = undefined;
				} else token = r.nextPageToken;
			}
			this.lastRefresh = Date.now();
			if (changed.length) {
				this.invalidate();
				this.dirty = true;
				for (const fn of this.listeners) fn(changed);
			}
			await this.saveSnapshot(changed.length > 0 && Date.now() - this.savedAt > SNAPSHOT_EVERY_MS);
			return changed;
		})().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	/** Refreshes when the last refresh is older than `maxAgeMs` (each request on a serverless host calls this). */
	async refreshIfStale(maxAgeMs = 10_000): Promise<void> {
		if (Date.now() - this.lastRefresh > maxAgeMs) await this.refresh();
	}

	// ── paths and search ─────────────────────────────────────────────────────

	/** The path of a file inside My Drive («Universidad/Apuntes/tema1.pdf»), or null when it is not in My Drive. */
	pathOf(id: string, depth = 0): string | null {
		if (id === this.rootId) return "";
		if (this.paths.has(id)) return this.paths.get(id) ?? null;
		const f = this.files.get(id);
		let path: string | null = null;
		if (f && depth < 64) {
			for (const parent of f.parents) {
				const p = this.pathOf(parent, depth + 1);
				if (p !== null) {
					path = p ? `${p}/${f.name}` : f.name;
					break;
				}
			}
		}
		this.paths.set(id, path);
		return path;
	}

	/** Whether a file is inside a folder, at any depth. */
	isUnder(id: string, folderId: string, depth = 0): boolean {
		const f = this.files.get(id);
		if (!f || depth > 64) return false;
		return f.parents.some((p) => p === folderId || this.isUnder(p, folderId, depth + 1));
	}

	/** Every file (not folder) inside a folder, at any depth. */
	filesUnder(folderId: string): DriveFile[] {
		return [...this.files.values()].filter((f) => f.mimeType !== FOLDER && this.isUnder(f.id, folderId));
	}

	get(id: string): DriveFile | null {
		return this.files.get(id) ?? null;
	}

	hit(f: DriveFile): FileHit {
		return { id: f.id, name: f.name, path: this.pathOf(f.id) ?? f.name, folder: f.mimeType === FOLDER, mime_type: f.mimeType, modified: f.modifiedTime, size: f.size, link: f.link };
	}

	private searchable(): { id: string; name: string; path: string }[] {
		if (!this.entries) {
			this.entries = [];
			for (const f of this.files.values()) {
				const path = this.pathOf(f.id);
				if (path !== null && path !== "") this.entries.push({ id: f.id, name: fold(f.name), path: fold(path) });
			}
		}
		return this.entries;
	}

	/**
	 * By name, from memory: every word must be in the name or the path (accents and case ignored). Best first: the
	 * name starts with the query, then contains it, then has all the words, then only the path matches; ties go to
	 * the most recently changed.
	 */
	search(query: string, opts: { limit?: number; folder?: string | null } = {}): FileHit[] {
		const q = fold(query.trim());
		if (!q) return [];
		const words = q.split(/\s+/).filter(Boolean);
		const folder = opts.folder ? fold(opts.folder.replace(/^\/+|\/+$/g, "")) : null;
		const scored: { id: string; score: number }[] = [];
		for (const e of this.searchable()) {
			if (folder && !e.path.startsWith(`${folder}/`)) continue;
			if (!words.every((w) => e.path.includes(w))) continue;
			const score = e.name.startsWith(q) ? 3 : e.name.includes(q) ? 2 : words.every((w) => e.name.includes(w)) ? 1 : 0;
			scored.push({ id: e.id, score });
		}
		const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
		return scored
			.sort((a, b) => b.score - a.score || (this.files.get(b.id)?.modifiedTime ?? "").localeCompare(this.files.get(a.id)?.modifiedTime ?? ""))
			.slice(0, limit)
			.map((s) => this.hit(this.files.get(s.id) as DriveFile));
	}

	/** Inside the files, with Drive's full-text index. Only files of My Drive are returned. */
	async searchContent(query: string, limit = 20): Promise<FileHit[]> {
		const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
		const r = await this.drive.json<{ files: ApiFile[] }>("GET", "/drive/v3/files", {
			query: { q: `fullText contains '${escaped}' and trashed = false`, pageSize: Math.min(limit * 2, 100), fields: `files(${FIELDS})`, spaces: "drive" },
		});
		const out: FileHit[] = [];
		for (const f of r.files) {
			const file = this.files.get(f.id);
			if (!file || this.pathOf(file.id) === null) continue; // shared with the user, not in My Drive
			out.push(this.hit(file));
			if (out.length >= limit) break;
		}
		return out;
	}

	/** A file's content: text when it has some (Google formats exported), else its bytes. */
	async read(id: string, opts: { maxChars?: number; maxBytes?: number } = {}): Promise<FileContent> {
		const f = this.files.get(id);
		if (!f) throw new DriveError(404, `No file with id «${id}» in this Drive.`);
		if (f.mimeType === FOLDER) throw new DriveError(400, `«${f.name}» is a folder.`);
		const maxChars = opts.maxChars ?? 100_000;
		const exportAs = EXPORTS[f.mimeType];
		if (exportAs || isText(f.mimeType)) {
			const data = exportAs ? await this.drive.bytes(`/drive/v3/files/${id}/export`, { mimeType: exportAs }) : await this.drive.bytes(`/drive/v3/files/${id}`, { alt: "media" });
			if (!data) throw new DriveError(404, `«${f.name}» could not be downloaded.`);
			const text = data.toString("utf8");
			return { kind: "text", text: text.slice(0, maxChars), mimeType: exportAs ?? f.mimeType, truncated: text.length > maxChars };
		}
		if (f.mimeType.startsWith("application/vnd.google-apps.")) throw new DriveError(415, `«${f.name}» is a Google ${f.mimeType.split(".").pop()}, which has no text export.`);
		const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
		if (f.size !== null && f.size > maxBytes) throw new DriveError(413, `«${f.name}» is ${(f.size / 1024 / 1024).toFixed(1)} MB; at most ${maxBytes / 1024 / 1024} MB.`);
		const data = await this.drive.bytes(`/drive/v3/files/${id}`, { alt: "media" });
		if (!data) throw new DriveError(404, `«${f.name}» could not be downloaded.`);
		return { kind: "binary", data, mimeType: f.mimeType, name: f.name };
	}

	/** Finds a folder by its path in My Drive («Memoria/Fuentes»), or null. */
	folderByPath(path: string): DriveFile | null {
		const want = path.replace(/^\/+|\/+$/g, "");
		for (const f of this.files.values()) if (f.mimeType === FOLDER && this.pathOf(f.id) === want) return f;
		return null;
	}
}
