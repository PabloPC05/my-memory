// A stand-in for the Google Drive API calls DriveFiles makes: files in memory, a changes feed, the app's hidden
// folder (appDataFolder), exports and full-text search over the files' text.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface FakeFile {
	id: string;
	name: string;
	mimeType: string;
	parents: string[];
	content?: Buffer;
	modifiedTime?: string;
	trashed?: boolean;
}

export interface FakeDrive {
	url: string;
	tokenUrl: string;
	calls: string[];
	channels: { id: string; address: string; token: string; stopped: boolean }[];
	add: (f: FakeFile) => void;
	update: (id: string, patch: Partial<FakeFile>) => void;
	remove: (id: string) => void;
	close: () => Promise<void>;
}

export const ROOT = "root-id";
let clock = Date.parse("2026-10-01T00:00:00Z");
const now = () => new Date((clock += 1000)).toISOString();

export async function fakeDrive(initial: FakeFile[] = []): Promise<FakeDrive> {
	const files = new Map<string, FakeFile>();
	const appdata = new Map<string, { name: string; content: Buffer }>();
	const changes: { fileId: string; removed: boolean }[] = [];
	const calls: string[] = [];
	const channels: FakeDrive["channels"] = [];
	for (const f of initial) files.set(f.id, { modifiedTime: now(), ...f });

	const api = (f: FakeFile) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, modifiedTime: f.modifiedTime, size: f.content ? String(f.content.length) : undefined, trashed: f.trashed ?? false });
	const send = (res: ServerResponse, status: number, body: unknown) => {
		const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
		res.writeHead(status, { "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" });
		res.end(data);
	};
	const body = (req: IncomingMessage) =>
		new Promise<Buffer>((ok) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => ok(Buffer.concat(chunks)));
		});

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const p = url.pathname;
		const q = url.searchParams;
		calls.push(`${req.method} ${p}${q.get("spaces") === "appDataFolder" ? " (appdata)" : ""}`);
		if (p === "/token") return send(res, 200, { access_token: "drive-token", expires_in: 3600 });
		if (req.headers.authorization !== "Bearer drive-token") return send(res, 401, { error: "unauthorized" });
		let m: RegExpExecArray | null;
		if (req.method === "GET" && p === "/drive/v3/files/root") return send(res, 200, { id: ROOT });
		if (req.method === "GET" && p === "/drive/v3/changes/startPageToken") return send(res, 200, { startPageToken: String(changes.length) });
		if (req.method === "GET" && p === "/drive/v3/changes") {
			const from = Number(q.get("pageToken"));
			// Like Drive: 50 changes a page, whatever pageSize asks for.
			const out = changes.slice(from, from + 50).map((c) => ({ fileId: c.fileId, removed: c.removed, ...(files.has(c.fileId) ? { file: api(files.get(c.fileId) as FakeFile) } : {}) }));
			return send(res, 200, from + 50 < changes.length ? { changes: out, nextPageToken: String(from + 50) } : { changes: out, newStartPageToken: String(changes.length) });
		}
		if (req.method === "GET" && p === "/drive/v3/files") {
			if (q.get("spaces") === "appDataFolder") {
				const name = /name = '([^']+)'/.exec(q.get("q") ?? "")?.[1];
				return send(res, 200, { files: [...appdata].filter(([, f]) => f.name === name).map(([id]) => ({ id })) });
			}
			const full = /fullText contains '((?:[^'\\]|\\.)*)'/.exec(q.get("q") ?? "")?.[1];
			let list = [...files.values()].filter((f) => !f.trashed);
			if (full) list = list.filter((f) => f.content?.toString("utf8").toLowerCase().includes(full.replace(/\\(.)/g, "$1").toLowerCase()));
			const since = /modifiedTime >= '([^']+)'/.exec(q.get("q") ?? "")?.[1];
			const before = /modifiedTime < '([^']+)'/.exec(q.get("q") ?? "")?.[1];
			if (since) list = list.filter((f) => (f.modifiedTime ?? "") >= since);
			if (before) list = list.filter((f) => (f.modifiedTime ?? "") < before);
			const size = Number(q.get("pageSize") ?? 100);
			const start = Number(q.get("pageToken") ?? 0);
			const page = list.slice(start, start + size);
			return send(res, 200, { files: page.map(api), ...(start + size < list.length ? { nextPageToken: String(start + size) } : {}) });
		}
		if (req.method === "GET" && (m = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(p))) {
			const f = files.get(m[1] as string);
			return f?.content ? send(res, 200, f.content) : send(res, 404, { error: "not found" });
		}
		if (req.method === "GET" && (m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p)) && q.get("alt") === "media") {
			const a = appdata.get(m[1] as string);
			if (a) return send(res, 200, a.content);
			const f = files.get(m[1] as string);
			return f?.content ? send(res, 200, f.content) : send(res, 404, { error: "not found" });
		}
		if (req.method === "POST" && p === "/drive/v3/changes/watch") {
			const b = JSON.parse((await body(req)).toString()) as { id: string; address: string; token: string; expiration: number };
			channels.push({ id: b.id, address: b.address, token: b.token, stopped: false });
			return send(res, 200, { kind: "api#channel", id: b.id, resourceId: `res-${b.id}`, expiration: String(b.expiration) });
		}
		if (req.method === "POST" && p === "/drive/v3/channels/stop") {
			const b = JSON.parse((await body(req)).toString()) as { id: string };
			for (const c of channels) if (c.id === b.id) c.stopped = true;
			return send(res, 204, Buffer.alloc(0));
		}
		if (req.method === "PATCH" && (m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
			const a = appdata.get(m[1] as string);
			if (!a) return send(res, 404, { error: "not found" });
			a.content = await body(req);
			return send(res, 200, { id: m[1] });
		}
		if (req.method === "POST" && p === "/upload/drive/v3/files") {
			const raw = await body(req);
			const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] ?? "")?.[1] as string;
			const parts = raw.toString("latin1").split(`--${boundary}`);
			const meta = JSON.parse(parts[1]?.split("\r\n\r\n")[1]?.trim() ?? "{}") as { name: string };
			const second = parts[2] as string;
			const content = Buffer.from(second.slice(second.indexOf("\r\n\r\n") + 4, second.length - 2), "latin1");
			const id = `appdata-${appdata.size + 1}`;
			appdata.set(id, { name: meta.name, content });
			return send(res, 200, { id });
		}
		return send(res, 404, { error: `fake: ${req.method} ${p}` });
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	return {
		url: base,
		tokenUrl: `${base}/token`,
		calls,
		channels,
		add: (f) => {
			files.set(f.id, { modifiedTime: now(), ...f });
			changes.push({ fileId: f.id, removed: false });
		},
		update: (id, patch) => {
			files.set(id, { ...(files.get(id) as FakeFile), ...patch, modifiedTime: now() });
			changes.push({ fileId: id, removed: false });
		},
		remove: (id) => {
			files.delete(id);
			changes.push({ fileId: id, removed: true });
		},
		close: () => new Promise((ok) => server.close(() => ok())),
	};
}
