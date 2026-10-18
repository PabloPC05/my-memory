import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EmbeddingsConfig } from "../src/embeddings.js";
import type { Logger } from "../src/log.js";
import { MemoryService } from "../src/memory.js";
import { SCHEMA_VERSION, SearchIndex } from "../src/search-index.js";
import { makeMemory, note, tempDir, writer } from "./helpers.js";

const SEED = {
	"temas/coche.md": note("Coche", "El coche familiar", "Un Seat Ibiza rojo de 2015. Pasa la ITV en marzo."),
	"temas/universidad.md": note("Universidad", "Carrera y asignaturas", "## Este curso\n\nCinco asignaturas; la peor es Estadística.\n\n## Exámenes\n\nEn enero.\n"),
	"temas/piso-de-oviedo.md": note("Piso de Oviedo", "El piso de Oviedo y su hipoteca", "Hipotecas y préstamos."),
};

// The fake model: bag of words hashed into 64 dimensions, with a few synonyms folded into one word, so
// «automóvil» lands where «coche» does while full-text search cannot see the relation.
const SYNONYMS: Record<string, string> = { automovil: "coche", vehiculo: "coche", carro: "coche", credito: "hipoteca" };
const DIMS = 64;

function fakeVector(text: string): number[] {
	const v = new Array<number>(DIMS).fill(0);
	const words = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
	for (const raw of words) {
		const word = SYNONYMS[raw] ?? raw;
		let h = 2166136261;
		for (const c of word) h = Math.imul(h ^ (c.codePointAt(0) as number), 16777619) >>> 0;
		v[h % DIMS] = (v[h % DIMS] as number) + 1;
	}
	return v;
}

interface FakeEndpoint {
	url: string;
	port: number;
	/** Every text received, in order. */
	inputs: string[];
	requests: { model: string; authorization: string | undefined }[];
	close: () => Promise<void>;
}

/** An OpenAI-compatible `/v1/embeddings`. Texts containing VENENO are refused with 400, like a model refuses an input that is too long. */
async function fakeEndpoint(port = 0): Promise<FakeEndpoint> {
	const inputs: string[] = [];
	const requests: FakeEndpoint["requests"] = [];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const parsed = JSON.parse(body) as { model: string; input: string[] };
			requests.push({ model: parsed.model, authorization: req.headers.authorization });
			if (parsed.input.some((t) => t.includes("VENENO"))) {
				res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"input too long"}');
				return;
			}
			inputs.push(...parsed.input);
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ object: "list", model: parsed.model, data: parsed.input.map((t, index) => ({ object: "embedding", index, embedding: fakeVector(t) })) }));
		});
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	const actual = (server.address() as AddressInfo).port;
	return { url: `http://127.0.0.1:${actual}/v1/embeddings`, port: actual, inputs, requests, close: () => new Promise((r) => server.close(() => r())) };
}

function config(url: string, extra: Partial<EmbeddingsConfig> = {}): EmbeddingsConfig {
	return { url, model: "fake-bow", apiKey: null, dimensions: null, batchSize: 2, timeoutSeconds: 5, queryPrefix: "", documentPrefix: "", ...extra };
}

function capture(): { log: Logger; lines: string[] } {
	const lines: string[] = [];
	return { lines, log: (level, event, fields) => lines.push(JSON.stringify({ level, event, ...fields })) };
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 20));
	}
}

let env: Awaited<ReturnType<typeof makeMemory>> | null = null;
let endpoint: FakeEndpoint | null = null;
afterEach(async () => {
	await env?.cleanup();
	await endpoint?.close();
	env = null;
	endpoint = null;
});

describe("embeddings", () => {
	it("without [embeddings] search is the full-text search, unchanged", async () => {
		env = await makeMemory(SEED);
		expect(env.memory.embedder).toBeNull();
		for (const query of ["hipoteca", "automóvil", "asignaturas enero"]) {
			expect(await env.memory.searchAny({ query, mode: "semantic" })).toEqual(env.memory.search({ query }));
		}
		expect(env.memory.search({ query: "hipoteca" })).toMatchObject({ mode: "all", hits: [{ path: "temas/piso-de-oviedo.md" }] });
		expect(env.memory.index.vectorCount()).toBe(0);
	});

	it("hybrid search finds a note by a related word that full text misses", async () => {
		endpoint = await fakeEndpoint();
		const { log, lines } = capture();
		env = await makeMemory(SEED, { embeddings: config(endpoint.url, { apiKey: "sk-test" }), log });
		const embedder = env.memory.embedder!;
		await embedder.idle();
		expect(embedder.status()).toEqual({ model: "fake-bow", vectors: 5, pending: 0 });
		expect(endpoint.requests.every((r) => r.authorization === "Bearer sk-test" && r.model === "fake-bow")).toBe(true);

		expect(env.memory.search({ query: "automóvil" }).hits).toEqual([]);
		const hybrid = await env.memory.searchAny({ query: "automóvil" });
		expect(hybrid.mode).toBe("hybrid");
		expect(hybrid.hits[0]).toMatchObject({ path: "temas/coche.md", section: { heading: "Coche" } });
		expect(hybrid.hits[0]?.snippet).toContain("Seat Ibiza");
		const semantic = await env.memory.searchAny({ query: "vehículo", mode: "semantic", limit: 1 });
		expect(semantic).toMatchObject({ mode: "semantic", hits: [{ path: "temas/coche.md" }] });
		// Words still win when they match: full-text hits keep their snippet with the match marked.
		const words = await env.memory.searchAny({ query: "hipoteca" });
		expect(words.hits[0]).toMatchObject({ path: "temas/piso-de-oviedo.md" });
		expect(words.hits[0]?.snippet).toContain("«");
		expect(await env.memory.searchAny({ query: "hipoteca", mode: "text" })).toEqual(env.memory.search({ query: "hipoteca" }));
		// Filters apply to the vectors too.
		expect((await env.memory.searchAny({ query: "automóvil", folder: "yo" })).hits).toEqual([]);
		// The text hits are read after the query is embedded (a reindex in between could renumber the sections),
		// and not at all in semantic mode.
		const order: string[] = [];
		const index = env.memory.index;
		const search = index.search.bind(index);
		const embedQuery = embedder.embedQuery.bind(embedder);
		index.search = (...a: Parameters<typeof search>) => (order.push("text"), search(...a));
		embedder.embedQuery = async (q: string) => (order.push("embed"), embedQuery(q));
		await env.memory.searchAny({ query: "automóvil" });
		expect(order).toEqual(["embed", "text"]);
		order.length = 0;
		await env.memory.searchAny({ query: "automóvil", mode: "semantic" });
		expect(order).toEqual(["embed"]);
		index.search = search;
		embedder.embedQuery = embedQuery;

		expect(lines.some((l) => l.includes('"embeddings.status"'))).toBe(true);
		expect(lines.join("\n")).not.toMatch(/autom|veh[ií]culo|sk-test/i);
	});

	it("embeds again only the sections whose text changed", async () => {
		endpoint = await fakeEndpoint();
		const ep = endpoint;
		env = await makeMemory(SEED, { embeddings: config(ep.url) });
		await env.memory.embedder!.idle();
		expect(ep.inputs).toHaveLength(5);

		ep.inputs.length = 0;
		await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], reason: "Seis" });
		await env.memory.embedder!.idle();
		expect(ep.inputs).toHaveLength(1);
		expect(ep.inputs[0]).toContain("Seis asignaturas");
		expect(ep.inputs[0]).toContain("Universidad › Este curso");
		expect(env.memory.embedder!.status()).toMatchObject({ vectors: 5, pending: 0 }); // the old vector is pruned

		// Same text elsewhere: a move or a full rebuild reuses the vectors.
		const { hash } = await env.memory.read({ name: "coche" });
		await env.memory.move(writer, { from: "coche", to: "temas/auto.md", hash, reason: "Renombrar" });
		await env.memory.rebuildIndex();
		await env.memory.embedder!.idle();
		expect(ep.inputs).toHaveLength(1);

		// A text the model refuses does not block the others.
		await env.memory.create(writer, { path: "temas/raro.md", content: note("Raro", "Nota rara", "## Bueno\n\nTexto normal.\n\n## Malo\n\nVENENO\n"), reason: "Rara" });
		await env.memory.embedder!.idle();
		expect(ep.inputs.slice(1).some((t) => t.includes("Texto normal"))).toBe(true);
		expect(env.memory.embedder!.status().pending).toBe(1);

		// Restarting keeps the vectors; another model embeds everything again.
		const opts = env.memory.opts;
		await env.memory.stop();
		ep.inputs.length = 0;
		const same = new MemoryService(opts);
		env.memory = same;
		await same.start();
		await same.embedder!.idle();
		expect(ep.inputs.filter((t) => !t.includes("VENENO"))).toHaveLength(0);
		await same.stop();
		const other = new MemoryService({ ...opts, embeddings: config(ep.url, { model: "fake-bow-2" }) });
		env.memory = other;
		await other.start();
		await other.embedder!.idle();
		expect(ep.inputs).toHaveLength(7);
		expect(ep.requests.at(-1)?.model).toBe("fake-bow-2");
	});

	it("with the endpoint down, writes succeed, search falls back to text, and embedding catches up later", async () => {
		const probe = await fakeEndpoint();
		const port = probe.port;
		await probe.close();
		const { log, lines } = capture();
		env = await makeMemory(SEED, { embeddings: config(`http://127.0.0.1:${port}/v1/embeddings`), embeddingsRetry: { initialMs: 50, maxMs: 200 }, log });
		const r = await env.memory.create(writer, { path: "temas/bici.md", content: note("Bici", "La bicicleta de montaña", "Cambio de pastillas de freno."), reason: "Bici" });
		expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(r.warnings).toEqual([]);

		const found = await env.memory.searchAny({ query: "pastillas freno" });
		expect(found).toEqual(env.memory.search({ query: "pastillas freno" }));
		expect(found.hits[0]?.path).toBe("temas/bici.md");
		await waitFor(() => lines.some((l) => l.includes('"embeddings.failed"')));
		const failed = lines.find((l) => l.includes('"search.embedding_failed"'));
		expect(failed).toContain('"level":"warn"');
		expect(lines.join("\n")).not.toMatch(/pastillas|freno/);
		expect(env.memory.embedder!.status()).toMatchObject({ vectors: 0, pending: 6 });

		endpoint = await fakeEndpoint(port);
		await waitFor(() => env!.memory.embedder!.status().pending === 0);
		expect(env.memory.embedder!.status().vectors).toBe(6);
	});

	it("replaces an index made with the previous schema", async () => {
		const path = join(await tempDir(), "index.sqlite");
		const old = new DatabaseSync(path);
		old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '2'), ('indexed_commit', 'abc');");
		old.exec("CREATE TABLE sections (id INTEGER PRIMARY KEY, path TEXT NOT NULL, ord INTEGER NOT NULL, heading TEXT NOT NULL, level INTEGER NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL)");
		old.close();
		const index = new SearchIndex(path);
		expect(index.getMeta("schema_version")).toBe(SCHEMA_VERSION);
		expect(index.getMeta("indexed_commit")).toBeNull();
		expect(index.pendingEmbeddingCount()).toBe(0);
		index.close();
	});

	it("opens an index read-only for the CLI, refusing another schema version instead of resetting it", async () => {
		const dir = await tempDir();
		const path = join(dir, "index.sqlite");
		expect(() => new SearchIndex(join(dir, "missing.sqlite"), { readOnly: true })).toThrow(/cannot open the index/);
		const old = new DatabaseSync(path);
		old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '2'), ('indexed_commit', 'abc');");
		old.close();
		expect(() => new SearchIndex(path, { readOnly: true })).toThrow(/schema version 2 and this my-memory expects/);
		const check = new DatabaseSync(path);
		expect(check.prepare("SELECT value FROM meta WHERE key = 'indexed_commit'").get()).toEqual({ value: "abc" }); // untouched
		check.close();
		new SearchIndex(path).close(); // the server's open rebuilds it
		const ro = new SearchIndex(path, { readOnly: true });
		expect(ro.getMeta("schema_version")).toBe(SCHEMA_VERSION);
		expect(() => ro.setMeta("x", "y")).toThrow(/readonly/i);
		ro.close();
	});

	it("reads [embeddings] from the config, with the key from a file", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "embeddings-key"), "sk-file\n");
		const file = join(dir, "config.toml");
		const base = `data_dir = "data"\n[listen.private]\nport = 8782\n`;
		await writeFile(file, base);
		expect(loadConfig(file).embeddings).toBeNull();
		await writeFile(file, `${base}[embeddings]\nurl = "http://127.0.0.1:11434/v1/embeddings"\nmodel = "nomic-embed-text"\napi_key_file = "embeddings-key"\nbatch_size = 8\nquery_prefix = "search_query: "\n`);
		expect(loadConfig(file).embeddings).toEqual({
			url: "http://127.0.0.1:11434/v1/embeddings",
			model: "nomic-embed-text",
			apiKey: "sk-file",
			apiKeyFile: join(dir, "embeddings-key"),
			dimensions: null,
			batchSize: 8,
			timeoutSeconds: 60,
			queryPrefix: "search_query: ",
			documentPrefix: "",
		});
		await writeFile(file, `${base}[embeddings]\nurl = "ollama"\nmodel = "x"\n`);
		expect(() => loadConfig(file)).toThrow(/http/);
	});
});
