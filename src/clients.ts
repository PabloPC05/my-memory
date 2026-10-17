import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Git } from "./git.js";

/** Who is calling; the subset of the client identity this module needs. */
export interface SeenClient {
	id: string;
	name: string;
	scope: "read" | "write";
}

export interface Seen extends SeenClient {
	lastSeen: string;
	lastTool: string | null;
}

type Row = Record<string, unknown>;

/**
 * Server-side "last seen" per client, kept in its own small SQLite file in the data dir (not in the notes repo,
 * and not in the search index, which can be rebuilt). The in-memory copy is always current; the file is written
 * at most once per client per `intervalMs`, and on `flush`/`close`.
 */
export class ClientActivity {
	readonly db: DatabaseSync;
	private readonly cache = new Map<string, Seen>();
	private readonly lastWrite = new Map<string, number>();
	private readonly dirty = new Set<string>();

	constructor(
		path: string,
		private readonly opts: { intervalMs?: number; now?: () => number } = {},
	) {
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
		this.db.exec("CREATE TABLE IF NOT EXISTS client_activity (client_id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL, last_seen TEXT NOT NULL, last_tool TEXT)");
		for (const s of ClientActivity.readAll(this.db)) this.cache.set(s.id, s);
	}

	private static readAll(db: DatabaseSync): Seen[] {
		return (db.prepare("SELECT * FROM client_activity").all() as Row[]).map((r) => ({
			id: r.client_id as string,
			name: r.name as string,
			scope: r.scope === "write" ? "write" : "read",
			lastSeen: r.last_seen as string,
			lastTool: (r.last_tool as string | null) ?? null,
		}));
	}

	/** Read-only snapshot of the file, for the CLI (no side effects; empty if the file does not exist yet). */
	static snapshot(path: string): Seen[] {
		let db: DatabaseSync | null = null;
		try {
			db = new DatabaseSync(path, { readOnly: true });
			return ClientActivity.readAll(db);
		} catch {
			return [];
		} finally {
			db?.close();
		}
	}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	/** Notes a request. `tool` is the tool called, or null for other requests (the last tool is kept). */
	record(client: SeenClient, tool: string | null): void {
		const at = this.now();
		const previous = this.cache.get(client.id);
		this.cache.set(client.id, { id: client.id, name: client.name, scope: client.scope, lastSeen: new Date(at).toISOString(), lastTool: tool ?? previous?.lastTool ?? null });
		if (at - (this.lastWrite.get(client.id) ?? 0) >= (this.opts.intervalMs ?? 60_000)) this.persist(client.id, at);
		else this.dirty.add(client.id);
	}

	private persist(id: string, at: number): void {
		const s = this.cache.get(id);
		if (!s) return;
		this.db
			.prepare(
				"INSERT INTO client_activity (client_id, name, scope, last_seen, last_tool) VALUES (?, ?, ?, ?, ?) ON CONFLICT (client_id) DO UPDATE SET name = excluded.name, scope = excluded.scope, last_seen = excluded.last_seen, last_tool = excluded.last_tool",
			)
			.run(s.id, s.name, s.scope, s.lastSeen, s.lastTool);
		this.lastWrite.set(id, at);
		this.dirty.delete(id);
	}

	/** Writes whatever the throttle held back. */
	flush(): void {
		if (!this.db.isOpen) return;
		const at = this.now();
		for (const id of [...this.dirty]) this.persist(id, at);
	}

	all(): Seen[] {
		return [...this.cache.values()];
	}

	close(): void {
		if (!this.db.isOpen) return;
		this.flush();
		this.db.close();
	}
}

export interface KnownClient {
	id: string;
	name: string;
	scope: "read" | "write";
}

export interface ClientReport {
	id: string;
	name: string;
	kind: "static" | "oauth";
	scope: "read" | "write" | null;
	/** False when the client only shows up in the activity log or in git (token revoked, OAuth client gone). */
	registered: boolean;
	last_seen: { at: string; tool: string | null } | null;
	writes: { last_7_days: number; last_30_days: number; last_write_at: string | null };
	/** Latest `memory-setup <version>` record found in the notes for this client, best effort. */
	setup: { version: string; note: string } | null;
}

export interface ClientsReport {
	generated_at: string;
	clients: ClientReport[];
}

interface Writes {
	name: string;
	last7: number;
	last30: number;
	last: string | null;
}

const DAY = 86_400_000;

/** Writes per client id, from the `Client:` trailers of the commits on the current branch. */
export async function writesFromGit(git: Git, now: number): Promise<Map<string, Writes>> {
	const out = await git.run(["log", "--format=%x1e%aI%x1f%an%x1f%(trailers:key=Client,valueonly,unfold)"], { allowFail: true });
	const result = new Map<string, Writes>();
	if (out.code !== 0) return result;
	for (const block of out.stdout.split("\x1e")) {
		const [date, author, trailer] = block.split("\x1f");
		const id = (trailer ?? "").trim().split("\n")[0]?.trim();
		const at = Date.parse(date ?? "");
		if (!id || Number.isNaN(at)) continue;
		const w = result.get(id) ?? { name: (author ?? id).trim() || id, last7: 0, last30: 0, last: null };
		if (now - at <= 7 * DAY) w.last7++;
		if (now - at <= 30 * DAY) w.last30++;
		if (!w.last || at > Date.parse(w.last)) w.last = new Date(at).toISOString();
		result.set(id, w);
	}
	return result;
}

const SETUP = /memory-setup\s*:?\s*v?(\d+(?:\.\d+){1,3})/gi;

function compareVersions(a: string, b: string): number {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/**
 * Setup records agents leave in the notes (`memory-setup 0.2.0`). A record belongs to the client whose id or name
 * appears in the same line, the three lines before it or the heading above it; failing that, to the only client named in the file;
 * failing that, to the client of the last commit that touched the file. Best effort: the latest version wins.
 */
export async function setupRecords(git: Git, repoDir: string, clients: KnownClient[]): Promise<Map<string, { version: string; note: string }>> {
	const found = new Map<string, { version: string; note: string }>();
	const grep = await git.run(["grep", "-l", "-i", "-I", "memory-setup", "--", "*.md"], { allowFail: true });
	const files = grep.code === 0 ? grep.stdout.split("\n").filter(Boolean) : [];
	const mentions = (text: string): string[] => {
		const t = text.toLowerCase();
		return clients.filter((c) => t.includes(c.id.toLowerCase()) || (c.name.length >= 3 && t.includes(c.name.toLowerCase()))).map((c) => c.id);
	};
	const keep = (id: string, version: string, note: string) => {
		const current = found.get(id);
		if (!current || compareVersions(version, current.version) > 0) found.set(id, { version, note });
	};
	for (const file of files) {
		const text = await readFile(join(repoDir, file), "utf8").catch(() => null);
		if (text === null) continue;
		const lines = text.split("\n");
		let byCommit: string | null | undefined;
		for (let i = 0; i < lines.length; i++) {
			for (const m of (lines[i] as string).matchAll(SETUP)) {
				const version = m[1] as string;
				let heading = i;
				while (heading > 0 && !/^#{1,6}\s/.test(lines[heading] as string)) heading--;
				let owners = mentions([lines[heading], ...lines.slice(Math.max(0, i - 3), i + 1)].join("\n"));
				if (owners.length === 0) {
					const all = mentions(text);
					if (all.length === 1) owners = all;
				}
				if (owners.length === 0) {
					if (byCommit === undefined) {
						const last = await git.run(["log", "-1", "--format=%(trailers:key=Client,valueonly,unfold)", "--", file], { allowFail: true });
						byCommit = last.stdout.trim().split("\n")[0]?.trim() || null;
					}
					if (byCommit) owners = [byCommit];
				}
				for (const id of owners) keep(id, version, file);
			}
		}
	}
	return found;
}

export interface ClientsSources {
	git: Git;
	repoDir: string;
	/** Static tokens, without hashes. */
	staticClients: () => Promise<KnownClient[]> | KnownClient[];
	oauthClients: () => { client_id: string; client_name: string | null }[];
	activity: () => Seen[];
	now?: () => number;
}

/** Every known client with its activity, writes and setup record. Never includes tokens or hashes. */
export async function buildClientsReport(src: ClientsSources): Promise<ClientsReport> {
	const now = src.now ? src.now() : Date.now();
	const writes = await writesFromGit(src.git, now);
	const seen = new Map(src.activity().map((s) => [s.id, s]));
	const known = new Map<string, { name: string; kind: "static" | "oauth"; scope: "read" | "write" | null; registered: boolean }>();
	for (const t of await src.staticClients()) known.set(t.id, { name: t.name, kind: "static", scope: t.scope, registered: true });
	for (const c of src.oauthClients()) {
		const id = `oauth:${c.client_id}`;
		known.set(id, { name: seen.get(id)?.name ?? c.client_name ?? id, kind: "oauth", scope: "write", registered: true });
	}
	for (const id of new Set([...seen.keys(), ...writes.keys()])) {
		if (known.has(id)) continue;
		known.set(id, { name: seen.get(id)?.name ?? writes.get(id)?.name ?? id, kind: id.startsWith("oauth:") ? "oauth" : "static", scope: seen.get(id)?.scope ?? null, registered: false });
	}
	const setup = await setupRecords(src.git, src.repoDir, [...known].map(([id, k]) => ({ id, name: k.name, scope: k.scope ?? "read" })));
	const clients: ClientReport[] = [...known].map(([id, k]) => {
		const s = seen.get(id);
		const w = writes.get(id);
		return {
			id,
			name: k.name,
			kind: k.kind,
			scope: k.scope,
			registered: k.registered,
			last_seen: s ? { at: s.lastSeen, tool: s.lastTool } : null,
			writes: { last_7_days: w?.last7 ?? 0, last_30_days: w?.last30 ?? 0, last_write_at: w?.last ?? null },
			setup: setup.get(id) ?? null,
		};
	});
	clients.sort((a, b) => (b.last_seen?.at ?? "").localeCompare(a.last_seen?.at ?? "") || a.id.localeCompare(b.id));
	return { generated_at: new Date(now).toISOString(), clients };
}

/** What the HTTP layer needs: note a request, and produce the report. */
export interface ClientsService {
	record(client: SeenClient, tool: string | null): void;
	report(): Promise<ClientsReport>;
}

function ago(iso: string | null, now: number): string {
	if (!iso) return "-";
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (s < 90) return "just now";
	if (s < 5400) return `${Math.round(s / 60)}m ago`;
	if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86_400)}d ago`;
}

/** Plain-text table for the CLI. */
export function renderClientsTable(report: ClientsReport): string {
	const now = Date.parse(report.generated_at);
	const header = ["ID", "NAME", "KIND", "SCOPE", "LAST SEEN", "LAST TOOL", "W7", "W30", "LAST WRITE", "SETUP"];
	const rows = report.clients.map((c) => [
		c.registered ? c.id : `${c.id} (gone)`,
		c.name,
		c.kind,
		c.scope ?? "?",
		ago(c.last_seen?.at ?? null, now),
		c.last_seen?.tool ?? "-",
		String(c.writes.last_7_days),
		String(c.writes.last_30_days),
		ago(c.writes.last_write_at, now),
		c.setup?.version ?? "-",
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
	const line = (cells: string[]) =>
		cells
			.map((c, i) => c.padEnd(widths[i] as number))
			.join("  ")
			.trimEnd();
	return [line(header), ...rows.map(line)].join("\n");
}
