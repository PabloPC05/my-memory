import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { FOLDER } from "../src/drive-files.js";
import { silentLogger } from "../src/log.js";
import { configFromEnv, createServerlessApp, type ServerlessApp } from "../src/vercel.js";
import { type FakeDrive, fakeDrive, ROOT } from "./fake-drive.js";
import { type FakeGitHub, fakeGitHub } from "./fake-github.js";
import { CONVENTIONS, note, seedRemote, tempDir } from "./helpers.js";

const TOKEN = "un-token-de-prueba-largo-1234";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of closers.splice(0).reverse()) await c();
});

async function setup() {
	const root = await tempDir("mm-vercel-");
	const bare = await seedRemote(root, { "memory.toml": CONVENTIONS, "temas/universidad.md": note("Universidad", "Carrera y asignaturas", "## Estado\n\nPreparando Estadística.\n") });
	const gh: FakeGitHub = await fakeGitHub(bare);
	const drive: FakeDrive = await fakeDrive([
		{ id: "mem", name: "Memoria", mimeType: FOLDER, parents: [ROOT] },
		{ id: "fuentes", name: "Fuentes", mimeType: FOLDER, parents: ["mem"] },
		{ id: "apuntes", name: "Apuntes de estadística.txt", mimeType: "text/plain", parents: [ROOT], content: Buffer.from("media y varianza") },
	]);
	closers.push(async () => {
		await gh.close();
		await drive.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5 });
	});
	const env = {
		GITHUB_REPO: "alex/memoria",
		GITHUB_TOKEN: "t0ken",
		GITHUB_API_URL: gh.url,
		MEMORY_TOKENS: `claude:write:${TOKEN}:Claude`,
		GOOGLE_CLIENT_ID: "c",
		GOOGLE_CLIENT_SECRET: "s",
		GOOGLE_REFRESH_TOKEN: "r",
		DRIVE_SOURCES_FOLDER: "Memoria/Fuentes",
		CRON_SECRET: "cron",
	};
	/** One copy of the function, as Vercel would start it, with its own /tmp. */
	const instance = async (n: number): Promise<{ app: ServerlessApp; url: string }> => {
		const config = { ...configFromEnv(env), dataDir: join(root, `tmp-${n}`) };
		config.files = config.files ? { ...config.files, drive: { ...config.files.drive, apiUrl: drive.url, tokenUrl: drive.tokenUrl } } : null;
		const app = await createServerlessApp(config, { log: silentLogger });
		const server: Server = createServer(app.handle);
		await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
		closers.push(async () => {
			await new Promise<void>((ok) => server.close(() => ok()));
			await app.memory.stop();
		});
		return { app, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
	};
	return { instance, gh, drive };
}

async function mcp(url: string): Promise<Client> {
	const client = new Client({ name: "test", version: "1" });
	await client.connect(new StreamableHTTPClientTransport(new URL(`/t/${TOKEN}/mcp`, url)));
	closers.push(() => client.close());
	return client;
}

const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? "{}");

describe("serverless (Vercel) mode", () => {
	it("serves the memory from GitHub and the files from Drive, with the token in the URL", async () => {
		const { instance } = await setup();
		const { url } = await instance(1);
		const client = await mcp(url);
		const tools = (await client.listTools()).tools.map((t) => t.name);
		expect(tools).toEqual(expect.arrayContaining(["search", "resume", "files_search", "files_read", "files_info", "create"]));
		expect(parse(await client.callTool({ name: "files_search", arguments: { query: "estadistica" } })).hits[0].path).toBe("Apuntes de estadística.txt");
		expect(parse(await client.callTool({ name: "files_read", arguments: { id: "apuntes" } })).text).toBe("media y varianza");
		expect(parse(await client.callTool({ name: "resume", arguments: { topic: "universidad" } })).intro).toContain("Preparando");
		const bad = await fetch(`${url}/t/otro-token-que-no-vale-123/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		expect(bad.status).toBe(401);
	});

	it("two copies see each other's writes", async () => {
		const { instance } = await setup();
		const a = await instance(1);
		const b = await instance(2);
		const ca = await mcp(a.url);
		const created = parse(await ca.callTool({ name: "create", arguments: { path: "personas/sara.md", content: note("Sara", "Amiga de la carrera", "Le gusta el té."), reason: "Nueva" } }));
		expect(created.commit).toMatch(/^[0-9a-f]{40}$/);
		await new Promise((r) => setTimeout(r, 5100)); // past SYNC_EVERY_MS
		const cb = await mcp(b.url);
		expect(parse(await cb.callTool({ name: "read", arguments: { name: "sara" } })).content).toContain("Le gusta el té.");
	}, 30_000);

	it("rejects bad configurations early", () => {
		expect(() => configFromEnv({ GITHUB_REPO: "solo", GITHUB_TOKEN: "x", MEMORY_TOKENS: "a:write:12345678901234567890" })).toThrow("owner/repo");
		expect(() => configFromEnv({ GITHUB_REPO: "a/b", GITHUB_TOKEN: "x", MEMORY_TOKENS: "a:write:corto" })).toThrow("at least 20");
		expect(() => configFromEnv({ GITHUB_REPO: "a/b", GITHUB_TOKEN: "x", MEMORY_TOKENS: "a:write:12345678901234567890", INGEST_PROVIDER: "anthropic" })).toThrow("DRIVE_SOURCES_FOLDER");
	});
});
