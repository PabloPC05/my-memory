import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addToken, TokenStore } from "../src/auth/tokens.js";
import { buildClientsReport, ClientActivity, type ClientsService, renderClientsTable, setupRecords, writesFromGit } from "../src/clients.js";
import { toolCalls, privateApp } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import type { ClientIdentity } from "../src/memory.js";
import { UploadStore } from "../src/uploads.js";
import { makeMemory, note, tempDir } from "./helpers.js";

const sam: ClientIdentity = { id: "sam-laptop", name: "Sam (laptop)", scope: "write" };
const alex: ClientIdentity = { id: "alex-phone", name: "Alex (phone)", scope: "write" };

describe("ClientActivity", () => {
	it("throttles writes to once per interval, keeps the last tool and survives a restart", async () => {
		const dir = await tempDir();
		const path = join(dir, "activity.sqlite");
		let now = Date.parse("2026-10-01T10:00:00Z");
		const a = new ClientActivity(path, { intervalMs: 60_000, now: () => now });
		a.record(sam, "search");
		now += 10_000;
		a.record(sam, null); // not a tool call: keeps «search»
		now += 10_000;
		a.record(sam, "read");
		// In memory it is current, on disk only the first write happened.
		expect(a.all()).toMatchObject([{ id: "sam-laptop", lastTool: "read", lastSeen: "2026-10-01T10:00:20.000Z" }]);
		expect(ClientActivity.snapshot(path)).toMatchObject([{ id: "sam-laptop", lastTool: "search", lastSeen: "2026-10-01T10:00:00.000Z" }]);
		now += 60_000;
		a.record(sam, "list");
		expect(ClientActivity.snapshot(path)).toMatchObject([{ lastTool: "list", lastSeen: "2026-10-01T10:01:20.000Z" }]);
		now += 5_000;
		a.record(alex, "read");
		now += 5_000;
		a.record(alex, "edit"); // throttled
		a.close(); // flushes what was held back
		const b = new ClientActivity(path);
		expect(b.all().map((s) => [s.id, s.name, s.scope, s.lastTool]).sort()).toEqual([
			["alex-phone", "Alex (phone)", "write", "edit"],
			["sam-laptop", "Sam (laptop)", "write", "list"],
		]);
		b.close();
	});

	it("reads an empty snapshot when the file does not exist", async () => {
		const dir = await tempDir();
		expect(ClientActivity.snapshot(join(dir, "nope.sqlite"))).toEqual([]);
	});
});

describe("toolCalls", () => {
	it("extracts tool names from single and batched JSON-RPC bodies", () => {
		expect(toolCalls({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: {} } })).toEqual(["search"]);
		expect(toolCalls([{ method: "initialize" }, { method: "tools/call", params: { name: "read" } }])).toEqual([null, "read"]);
		expect(toolCalls(undefined)).toEqual([]);
		expect(toolCalls("junk")).toEqual([]);
	});
});

describe("clients report", () => {
	let env: Awaited<ReturnType<typeof makeMemory>>;
	beforeAll(async () => {
		env = await makeMemory({ "yo/perfil.md": note("Perfil", "Quién es") }, { noRemote: true });
		await env.memory.create(sam, { path: "temas/uno.md", content: note("Uno", "Primera"), reason: "Primera" });
		await env.memory.create(sam, { path: "temas/dos.md", content: note("Dos", "Segunda"), reason: "Segunda" });
		await env.memory.create({ id: "old-bot", name: "Old Bot", scope: "write" }, { path: "temas/tres.md", content: note("Tres", "Tercera"), reason: "Tercera" });
		const setup = ["# Setup records", "", "## Sam (laptop)", "Instructions installed.", "memory-setup 0.1.0", "", "memory-setup 0.2.0", "", "## Alex (phone)", "memory-setup: 0.1.5", ""].join("\n");
		await env.memory.create(alex, { path: "temas/setup.md", content: note("Setup", "Registro de instalaciones", setup), reason: "Registro" });
	});
	afterAll(async () => {
		await env?.cleanup();
	});

	it("counts writes per client from the Client trailers, by window", async () => {
		const now = Date.now();
		const w = await writesFromGit(env.memory.git, now);
		expect(w.get("sam-laptop")).toMatchObject({ last7: 2, last30: 2 });
		expect(w.get("sam-laptop")?.last).toBeTruthy();
		const later = await writesFromGit(env.memory.git, now + 10 * 86_400_000);
		expect(later.get("sam-laptop")).toMatchObject({ last7: 0, last30: 2 });
		const muchLater = await writesFromGit(env.memory.git, now + 60 * 86_400_000);
		expect(muchLater.get("sam-laptop")).toMatchObject({ last7: 0, last30: 0 });
		expect(muchLater.get("sam-laptop")?.last).toBeTruthy();
	});

	it("finds the latest memory-setup version per client", async () => {
		const records = await setupRecords(env.memory.git, env.memory.opts.repoDir, [
			{ id: "sam-laptop", name: "Sam (laptop)", scope: "write" },
			{ id: "alex-phone", name: "Alex (phone)", scope: "write" },
		]);
		expect(records.get("sam-laptop")).toEqual({ version: "0.2.0", note: "temas/setup.md" });
		expect(records.get("alex-phone")).toEqual({ version: "0.1.5", note: "temas/setup.md" });
	});

	it("joins static tokens, OAuth clients, activity and git-only ids, without secrets", async () => {
		const report = await buildClientsReport({
			git: env.memory.git,
			repoDir: env.memory.opts.repoDir,
			staticClients: () => [
				{ id: "sam-laptop", name: "Sam (laptop)", scope: "write" },
				{ id: "quiet-reader", name: "Quiet Reader", scope: "read" },
			],
			oauthClients: () => [{ client_id: "abc123", client_name: "Chat app" }],
			activity: () => [
				{ id: "sam-laptop", name: "Sam (laptop)", scope: "write", lastSeen: "2026-10-01T10:00:00.000Z", lastTool: "edit" },
				{ id: "oauth:abc123", name: "Alex (Chat app)", scope: "write", lastSeen: "2026-10-02T10:00:00.000Z", lastTool: "search" },
			],
		});
		const by = Object.fromEntries(report.clients.map((c) => [c.id, c]));
		expect(Object.keys(by).sort()).toEqual(["alex-phone", "oauth:abc123", "old-bot", "quiet-reader", "sam-laptop"]);
		expect(by["sam-laptop"]).toMatchObject({ kind: "static", scope: "write", registered: true, last_seen: { tool: "edit" }, writes: { last_7_days: 2, last_30_days: 2 }, setup: { version: "0.2.0" } });
		expect(by["quiet-reader"]).toMatchObject({ scope: "read", last_seen: null, writes: { last_7_days: 0, last_write_at: null }, setup: null });
		expect(by["oauth:abc123"]).toMatchObject({ kind: "oauth", name: "Alex (Chat app)", registered: true, last_seen: { tool: "search" } });
		expect(by["old-bot"]).toMatchObject({ kind: "static", name: "Old Bot", registered: false, scope: null });
		expect(report.clients[0]?.id).toBe("oauth:abc123"); // most recently seen first
		expect(JSON.stringify(report)).not.toMatch(/hash|sha256|secret/i);
		const table = renderClientsTable(report);
		expect(table.split("\n")[0]).toMatch(/^ID\s+NAME\s+KIND\s+SCOPE\s+LAST SEEN/);
		expect(table).toContain("old-bot (gone)");
		expect(table).toContain("0.2.0");
	});

	it("copes with an empty repo", async () => {
		const empty = await makeMemory({}, { noRemote: true });
		try {
			const report = await buildClientsReport({ git: empty.memory.git, repoDir: empty.memory.opts.repoDir, staticClients: () => [], oauthClients: () => [], activity: () => [] });
			expect(report.clients).toEqual([]);
		} finally {
			await empty.cleanup();
		}
	});
});

describe("clients over MCP", () => {
	let env: Awaited<ReturnType<typeof makeMemory>>;
	let server: Server;
	let url: string;
	let activity: ClientActivity;
	let writeToken: string;
	let readToken: string;

	beforeAll(async () => {
		env = await makeMemory({ "yo/perfil.md": note("Perfil", "Quién es") }, { noRemote: true });
		const tokensFile = join(env.root, "tokens.toml");
		writeToken = await addToken(tokensFile, "sam-laptop", "Sam (laptop)", "write");
		readToken = await addToken(tokensFile, "alex-reader", "Alex (reader)", "read");
		const tokens = new TokenStore(tokensFile);
		const uploads = new UploadStore(join(env.root, "data", "uploads"));
		await uploads.init();
		activity = new ClientActivity(join(env.root, "data", "activity.sqlite"));
		const clients: ClientsService = {
			record: (c, t) => activity.record(c, t),
			report: () =>
				buildClientsReport({ git: env.memory.git, repoDir: env.memory.opts.repoDir, staticClients: () => tokens.list(), oauthClients: () => [], activity: () => activity.all() }),
		};
		const app = privateApp({ memory: env.memory, tokens, uploads, log: silentLogger, clients });
		server = await new Promise((resolve) => {
			const s = app.listen(0, "127.0.0.1", () => resolve(s));
		});
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(async () => {
		await new Promise((r) => server?.close(r));
		activity?.close();
		await env?.cleanup();
	});

	async function connect(token: string): Promise<Client> {
		const client = new Client({ name: "test", version: "1" });
		await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
		return client;
	}

	it("offers the read-only `clients` tool to read and write scopes and records who calls", async () => {
		const writer = await connect(writeToken);
		await writer.callTool({ name: "create", arguments: { path: "temas/nueva.md", content: note("Nueva", "Una nota"), reason: "Prueba" } });
		const reader = await connect(readToken);
		expect((await reader.listTools()).tools.map((t) => t.name)).toContain("clients");
		await reader.callTool({ name: "search", arguments: { query: "perfil" } });
		const result = (await reader.callTool({ name: "clients", arguments: {} })) as { content: { text: string }[] };
		const text = result.content[0]?.text ?? "";
		const report = JSON.parse(text) as { clients: { id: string; scope: string; last_seen: { tool: string } | null; writes: { last_7_days: number } }[] };
		const by = Object.fromEntries(report.clients.map((c) => [c.id, c]));
		expect(by["sam-laptop"]).toMatchObject({ scope: "write", last_seen: { tool: "create" }, writes: { last_7_days: 1 } });
		expect(by["alex-reader"]).toMatchObject({ scope: "read", last_seen: { tool: "clients" }, writes: { last_7_days: 0 } });
		expect(text).not.toContain("sha256");
		expect((await writer.listTools()).tools.map((t) => t.name)).toContain("clients");
		await writer.close();
		await reader.close();
	});
});
