import { type DriveFile, type DriveFiles, FOLDER } from "./drive-files.js";

/** What the memory knows about one source document: the version it last integrated, and how that went. */
export interface SourceRecord {
	name: string;
	path: string;
	/** The file's md5 (or its modification time, for Google's own formats). */
	version: string;
	status: "ingested" | "delegated" | "failed";
	at: string;
	/** Whether some version of it was ever integrated (so a later run updates rather than adds). */
	ingested?: boolean;
	/** Notes the ingestion changed. */
	notes?: string[];
	summary?: string;
	error?: string;
	/** Failed attempts at this version; after MAX_ATTEMPTS it waits for a new version. */
	attempts?: number;
}

/** `.my-memory/sources.json` in the notes repo. */
export interface SourcesState {
	v: 1;
	files: Record<string, SourceRecord>;
	/** A run in progress, on hosts that run several copies at once. */
	lease?: { by: string; until: string };
}

export interface SourceTask {
	kind: "added" | "changed" | "removed";
	id: string;
	name: string;
	path: string;
	version: string | null;
	mimeType: string | null;
	previous: SourceRecord | null;
}

export const MAX_ATTEMPTS = 3;
/** After MAX_ATTEMPTS, a failed version is tried again once a day (the provider or the config may have been fixed). */
const RETRY_FAILED_MS = 24 * 3600 * 1000;
export const emptySources = (): SourcesState => ({ v: 1, files: {} });

const versionOf = (f: DriveFile) => f.md5 ?? f.modifiedTime;

/**
 * The sources folder: a subfolder of the user's Drive (for example «Memoria/Fuentes») whose documents feed the
 * memory. Only what is inside it is read by the ingestion agent; the rest of the Drive is only searched and read
 * when an agent asks. Each document's identity is its Drive file id, which survives renames, moves and new
 * versions; notes cite it as `source:<id>`.
 */
export class DriveSources {
	constructor(
		private readonly files: DriveFiles,
		/** The folder's path in My Drive, or its id. */
		readonly folder: string,
	) {}

	/** The folder's id, or null when it does not exist (yet). */
	folderId(): string | null {
		const byId = this.files.get(this.folder);
		if (byId?.mimeType === FOLDER) return byId.id;
		return this.files.folderByPath(this.folder)?.id ?? null;
	}

	/** Whether any of these changed ids is (or was) a source. */
	touches(ids: string[], state: SourcesState | null): boolean {
		const folder = this.folderId();
		return ids.some((id) => (folder !== null && this.files.isUnder(id, folder)) || Boolean(state?.files[id]));
	}

	/** What is new, changed or gone since the state, oldest change first. Failed versions wait for a new one. */
	pending(state: SourcesState, now = Date.now()): SourceTask[] {
		const folder = this.folderId();
		const present = folder ? this.files.filesUnder(folder) : [];
		const tasks: SourceTask[] = [];
		const seen = new Set<string>();
		for (const f of present.sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime))) {
			seen.add(f.id);
			const version = versionOf(f);
			const known = state.files[f.id];
			const waiting = known?.status === "failed" && (known.attempts ?? 1) >= MAX_ATTEMPTS && now - Date.parse(known.at) < RETRY_FAILED_MS;
			if (known?.version === version && (known.status !== "failed" || waiting)) continue;
			const path = this.files.pathOf(f.id) ?? f.name;
			tasks.push({ kind: known?.ingested ? "changed" : "added", id: f.id, name: f.name, path, version, mimeType: f.mimeType, previous: known ?? null });
		}
		for (const [id, record] of Object.entries(state.files)) {
			if (seen.has(id)) continue;
			tasks.push({ kind: "removed", id, name: record.name, path: record.path, version: null, mimeType: null, previous: record });
		}
		return tasks;
	}
}
