import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { FOLDER } from "../src/drive-files.js";
import type { IngestAgent } from "../src/ingest.js";
import { Integrations } from "../src/integrations.js";
import { type FakeDrive, fakeDrive, ROOT } from "./fake-drive.js";
import { makeMemory } from "./helpers.js";

let drive: FakeDrive | null = null;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	await drive?.close();
	drive = null;
	for (const c of closers.splice(0)) await c();
});

async function setup() {
	drive = await fakeDrive([
		{ id: "mem", name: "Memoria", mimeType: FOLDER, parents: [ROOT] },
		{ id: "fuentes", name: "Fuentes", mimeType: FOLDER, parents: ["mem"] },
	]);
	const env = await makeMemory();
	closers.push(env.cleanup);
	const handled: string[] = [];
	const agent: IngestAgent = { name: "test", handle: async (task) => (handled.push(task.id), { summary: "", notes: [] }) };
	const integrations = new Integrations(
		env.memory,
		{ drive: { clientId: "c", clientSecret: "s", refreshToken: "r", apiUrl: drive.url, tokenUrl: drive.tokenUrl }, sourcesFolder: "Memoria/Fuentes", snapshot: false, push: { address: "https://memoria.example/hooks/drive", token: "canal-secreto" } },
		{ provider: "webhook" },
		{ agent },
	);
	await integrations.start();
	env.memory.files = integrations.files;
	const app = express();
	app.use(integrations.routes({ cronSecret: "cron-secreto" }));
	const url = await new Promise<string>((ok) => {
		const server = app.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
		closers.push(() => new Promise((done) => server.close(() => done())));
	});
	return { integrations, memory: env.memory, handled, url, drive };
}

describe("Integrations", () => {
	it("ingests on Drive's notice, only with the channel's token", async () => {
		const { handled, url, drive } = await setup();
		drive.add({ id: "nuevo", name: "Nuevo.txt", mimeType: "text/plain", parents: ["fuentes"], content: Buffer.from("hola") });
		const bad = await fetch(`${url}/hooks/drive`, { method: "POST", headers: { "x-goog-channel-token": "otro", "x-goog-resource-state": "change" } });
		expect(bad.status).toBe(401);
		expect(handled).toEqual([]);
		const sync = await fetch(`${url}/hooks/drive`, { method: "POST", headers: { "x-goog-channel-token": "canal-secreto", "x-goog-resource-state": "sync" } });
		expect(sync.status).toBe(204);
		expect(handled).toEqual([]);
		const ok = await fetch(`${url}/hooks/drive`, { method: "POST", headers: { "x-goog-channel-token": "canal-secreto", "x-goog-resource-state": "change" } });
		expect(ok.status).toBe(204);
		expect(handled).toEqual(["nuevo"]);
	});

	it("the cron call checks and keeps one push channel alive", async () => {
		const { url, drive, memory } = await setup();
		expect((await fetch(`${url}/cron/ingest`)).status).toBe(401);
		const r = await fetch(`${url}/cron/ingest`, { headers: { authorization: "Bearer cron-secreto" } });
		expect(r.status).toBe(200);
		expect(((await r.json()) as { watch: string }).watch).toMatch(/^renewed until/);
		expect(drive.channels).toHaveLength(1);
		expect(drive.channels[0]).toMatchObject({ address: "https://memoria.example/hooks/drive", token: "canal-secreto" });
		const again = (await (await fetch(`${url}/cron/ingest`, { headers: { authorization: "Bearer cron-secreto" } })).json()) as { watch: string };
		expect(again.watch).toMatch(/^ok until/);
		expect(drive.channels).toHaveLength(1);
		// about to expire: a new channel, and the old one stopped
		const state = (await memory.readState<{ expiration: string }>("drive-watch")) as Record<string, string>;
		await memory.saveState({ id: "t", name: "t", scope: "write" }, "drive-watch", { ...state, expiration: new Date(Date.now() + 3600_000).toISOString() }, "test");
		await fetch(`${url}/cron/ingest`, { headers: { authorization: "Bearer cron-secreto" } });
		expect(drive.channels.map((c) => c.stopped)).toEqual([true, false]);
	});
});
