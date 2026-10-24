import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DriveClient } from "../src/drive.js";
import { DriveFiles, FOLDER } from "../src/drive-files.js";
import { type IngestAgent, Ingester, ingestBrief, memoryTools } from "../src/ingest.js";
import { MemoryService } from "../src/memory.js";
import { UploadStore } from "../src/uploads.js";
import { DriveSources, type SourcesState, type SourceTask } from "../src/sources.js";
import { type FakeDrive, fakeDrive, ROOT } from "./fake-drive.js";
import { makeMemory, note } from "./helpers.js";

const NOTE = (cite: string) => note("Alquiler", "Contrato de alquiler del piso", `La renta es de 800 €.\n\n## Fuentes\n\n- ${cite}\n`);

let drive: FakeDrive | null = null;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
	await drive?.close();
	await cleanup?.();
	drive = null;
	cleanup = null;
});

/** An agent that writes through the same in-process tools the real ones get. */
function scriptedAgent(memory: MemoryService, seen: { task: SourceTask; text: string | null }[], fail = false): IngestAgent {
	return {
		name: "scripted",
		async handle(task, content) {
			seen.push({ task, text: content?.kind === "text" ? content.text : null });
			if (fail) throw new Error("model unavailable");
			const touched = new Set<string>();
			const tools = Object.fromEntries(memoryTools(memory, { id: "ingest", name: "Ingestion", scope: "write" }, touched).map((t) => [t.name, t]));
			const cite = `source:${task.id}`;
			if (task.kind === "added") await tools.create?.run({ path: "temas/alquiler.md", content: NOTE(cite), reason: "Ingesta del contrato" });
			else if (task.kind === "changed") await tools.edit?.run({ path: "temas/alquiler.md", edits: [{ old_string: "800 €", new_string: "850 €" }], reason: "Nueva versión del contrato" });
			else await tools.edit?.run({ path: "temas/alquiler.md", edits: [{ old_string: `- ${cite}`, new_string: `- ${cite} (ya no está en las fuentes)` }], reason: "Contrato retirado" });
			return { summary: `${task.kind} ${task.name}`, notes: [...touched] };
		},
	};
}

async function setup(fail = false) {
	drive = await fakeDrive([
		{ id: "mem", name: "Memoria", mimeType: FOLDER, parents: [ROOT] },
		{ id: "fuentes", name: "Fuentes", mimeType: FOLDER, parents: ["mem"] },
		{ id: "otro", name: "Otro.txt", mimeType: "text/plain", parents: [ROOT], content: Buffer.from("fuera de las fuentes") },
	]);
	const env = await makeMemory();
	cleanup = env.cleanup;
	const files = new DriveFiles(new DriveClient({ clientId: "c", clientSecret: "s", refreshToken: "r", apiUrl: drive.url, tokenUrl: drive.tokenUrl }), { snapshot: false });
	await files.start();
	const sources = new DriveSources(files, "Memoria/Fuentes");
	const seen: { task: SourceTask; text: string | null }[] = [];
	const ingester = new Ingester(env.memory, files, sources, scriptedAgent(env.memory, seen, fail), { provider: "webhook" });
	return { memory: env.memory, files, sources, ingester, seen, drive };
}

describe("ingestion of the sources folder", () => {
	it("integrates new, changed and removed sources once each, and keeps its state in the repo", async () => {
		const { memory, ingester, seen, drive } = await setup();
		expect((await ingester.run("test")).done).toEqual([]);

		drive.add({ id: "contrato", name: "Contrato.txt", mimeType: "text/plain", parents: ["fuentes"], content: Buffer.from("renta 800") });
		const first = await ingester.run("test");
		expect(first.failed).toEqual([]);
		expect(first.done.map((d) => [d.kind, d.notes])).toEqual([["added", ["temas/alquiler.md"]]]);
		expect(seen[0]?.text).toBe("renta 800");
		expect((await memory.read({ path: "temas/alquiler.md" })).content).toContain("source:contrato");
		const state = await memory.readState<SourcesState>("sources");
		expect(state?.files.contrato).toMatchObject({ status: "ingested", ingested: true, notes: ["temas/alquiler.md"] });
		expect(JSON.stringify(await memory.list({}))).not.toContain(".my-memory"); // not a note

		expect((await ingester.run("again")).done).toEqual([]); // nothing new
		drive.update("otro", { content: Buffer.from("cambiado") }); // outside the folder: ignored
		expect((await ingester.run("again")).done).toEqual([]);

		drive.update("contrato", { content: Buffer.from("renta 850"), modifiedTime: undefined });
		// the fake has no md5, so the version is the modification time, which update() moves forward
		expect((await ingester.run("test")).done.map((d) => d.kind)).toEqual(["changed"]);
		expect((await memory.read({ path: "temas/alquiler.md" })).content).toContain("850 €");

		drive.remove("contrato");
		expect((await ingester.run("test")).done.map((d) => d.kind)).toEqual(["removed"]);
		expect((await memory.read({ path: "temas/alquiler.md" })).content).toContain("ya no está en las fuentes");
		expect((await memory.readState<SourcesState>("sources"))?.files).toEqual({});
	});

	it("retries a failing source a few times, then waits for a new version", async () => {
		const { memory, ingester, seen, drive } = await setup(true);
		drive.add({ id: "roto", name: "Roto.txt", mimeType: "text/plain", parents: ["fuentes"], content: Buffer.from("x") });
		for (let i = 0; i < 4; i++) await ingester.run("test");
		expect(seen).toHaveLength(3);
		expect((await memory.readState<SourcesState>("sources"))?.files.roto).toMatchObject({ status: "failed", attempts: 3, error: "model unavailable" });
		drive.update("roto", { content: Buffer.from("y") });
		await ingester.run("test");
		expect(seen).toHaveLength(4);
	});

	it("handles a few sources per run and leaves the rest for the next one", async () => {
		const { ingester, drive } = await setup();
		for (const n of [1, 2, 3, 4]) drive.add({ id: `f${n}`, name: `F${n}.txt`, mimeType: "text/plain", parents: ["fuentes"], content: Buffer.from(String(n)) });
		const agentless = new Ingester((ingester as unknown as { memory: MemoryService }).memory, (ingester as unknown as { files: DriveFiles }).files, (ingester as unknown as { sources: DriveSources }).sources, { name: "noop", handle: async () => ({ summary: "", notes: [] }) }, { provider: "webhook", maxFilesPerRun: 3 });
		const r = await agentless.run("test");
		expect([r.done.length, r.remaining]).toEqual([3, 1]);
		expect((await agentless.run("test")).done.map((d) => d.id)).toEqual(["f4"]);
	});

	it("with a lease, two copies of the server given the same upload ingest it once", async () => {
		const { memory, files, sources, drive } = await setup();
		const env = memory.opts;
		const uploads = new UploadStore(join(env.repoDir, "..", "..", "data2", "uploads"));
		await uploads.init();
		const other = new MemoryService({ repoDir: join(env.repoDir, "..", "..", "data2", "repo"), indexPath: join(env.repoDir, "..", "..", "data2", "index.sqlite"), remote: env.remote, uploads });
		await other.start();
		try {
			let calls = 0;
			const agent: IngestAgent = { name: "count", handle: async () => ({ summary: String(++calls), notes: [] }) };
			const a = new Ingester(memory, files, sources, agent, { provider: "webhook" }, { lease: true });
			const b = new Ingester(other, files, sources, agent, { provider: "webhook" }, { lease: true });
			drive.add({ id: "subida", name: "Subida.txt", mimeType: "text/plain", parents: ["fuentes"], content: Buffer.from("hola") });
			const [ra, rb] = await Promise.all([a.run("push"), b.run("push")]);
			expect(calls).toBe(1);
			expect([ra.skipped, rb.skipped].filter(Boolean)).toEqual(["running"]);
			expect((await a.run("cron")).done).toEqual([]);
		} finally {
			await other.stop();
		}
	});

	it("with a time budget, stops starting sources once it is spent and counts the rest", async () => {
		const { memory, files, sources, drive } = await setup();
		for (const n of [1, 2, 3]) drive.add({ id: `t${n}`, name: `T${n}.txt`, mimeType: "text/plain", parents: ["fuentes"], content: Buffer.from(String(n)) });
		const ingester = new Ingester(memory, files, sources, { name: "noop", handle: async () => ({ summary: "", notes: [] }) }, { provider: "webhook" }, { budgetMs: 0 });
		const r = await ingester.run("test");
		expect([r.done.length, r.remaining]).toEqual([1, 2]);
		expect((await ingester.run("test")).done).toHaveLength(1);
	});

	it("tells the agent what to do and how to cite", () => {
		const brief = ingestBrief({ kind: "changed", id: "abc", name: "Contrato.pdf", path: "Memoria/Fuentes/Contrato.pdf", version: "1", mimeType: "application/pdf", previous: null });
		expect(brief).toContain("source:abc");
		expect(brief).toContain("new version");
	});
});
