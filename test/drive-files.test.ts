import { afterEach, describe, expect, it } from "vitest";
import { DriveClient } from "../src/drive.js";
import { DriveFiles, FOLDER } from "../src/drive-files.js";
import { type FakeDrive, fakeDrive, ROOT } from "./fake-drive.js";

const PDF = "application/pdf";
const SEED = [
	{ id: "uni", name: "Universidad", mimeType: FOLDER, parents: [ROOT] },
	{ id: "apuntes", name: "Apuntes", mimeType: FOLDER, parents: ["uni"] },
	{ id: "tema1", name: "Tema 1 - Estadística.pdf", mimeType: PDF, parents: ["apuntes"], content: Buffer.from("%PDF varianza y media") },
	{ id: "notas", name: "notas.txt", mimeType: "text/plain", parents: ["apuntes"], content: Buffer.from("examen en enero") },
	{ id: "doc", name: "Plan de estudio", mimeType: "application/vnd.google-apps.document", parents: ["uni"], content: Buffer.from("Repasar estadística los lunes") },
	{ id: "mem", name: "Memoria", mimeType: FOLDER, parents: [ROOT] },
	{ id: "fuentes", name: "Fuentes", mimeType: FOLDER, parents: ["mem"] },
	{ id: "contrato", name: "Contrato alquiler.pdf", mimeType: PDF, parents: ["fuentes"], content: Buffer.from("%PDF renta 800") },
	{ id: "ajeno", name: "Estadística compartida.pdf", mimeType: PDF, parents: ["carpeta-de-otro"], content: Buffer.from("%PDF") },
];

let drive: FakeDrive | null = null;
afterEach(async () => {
	await drive?.close();
	drive = null;
});

async function index(d: FakeDrive, snapshot = true): Promise<DriveFiles> {
	// Few lists at once: on Windows, many local connections at a time trip up the other test files' fakes.
	const files = new DriveFiles(new DriveClient({ clientId: "c", clientSecret: "s", refreshToken: "r", apiUrl: d.url, tokenUrl: d.tokenUrl }), { snapshot, parallel: 2 });
	await files.start();
	return files;
}

describe("DriveFiles", () => {
	it("indexes My Drive with paths and searches by name from memory", async () => {
		drive = await fakeDrive(SEED);
		const files = await index(drive);
		expect(files.pathOf("tema1")).toBe("Universidad/Apuntes/Tema 1 - Estadística.pdf");
		expect(files.pathOf("ajeno")).toBeNull(); // shared with the user, not in My Drive
		const hits = files.search("estadistica");
		expect(hits.map((h) => h.id)).toEqual(["tema1"]);
		expect(files.search("universidad notas").map((h) => h.id)).toEqual(["notas"]); // words across the path
		expect(files.search("tema", { folder: "Universidad/Apuntes" })[0]?.path).toBe("Universidad/Apuntes/Tema 1 - Estadística.pdf");
		expect(files.search("apuntes")[0]?.id).toBe("apuntes"); // the name itself first
		expect(files.folderByPath("Memoria/Fuentes")?.id).toBe("fuentes");
		expect(files.filesUnder("fuentes").map((f) => f.id)).toEqual(["contrato"]);
	});

	it("lists a big Drive (more than one page) in spans of time side by side, every file once", async () => {
		const many = Array.from({ length: 1500 }, (_, i) => ({ id: `f${i}`, name: `Archivo ${i}.txt`, mimeType: "text/plain", parents: [ROOT], modifiedTime: `${2003 + (i % 25)}-06-01T10:00:00.000Z` }));
		drive = await fakeDrive(many);
		const files = await index(drive, false);
		expect(files.size).toBe(1500);
		expect(files.search("archivo 1499")[0]?.id).toBe("f1499");
		expect(drive.calls.filter((c) => c === "GET /drive/v3/files").length).toBeGreaterThan(20); // the first page, then the spans
	});

	it("after a burst of changes (more pages than it is worth reading), lists everything again", async () => {
		drive = await fakeDrive(SEED);
		const files = await index(drive, false);
		for (let i = 0; i < 2100; i++) drive.update("notas", { name: `notas ${i}.txt` });
		drive.add({ id: "nuevo", name: "Recibo.pdf", mimeType: PDF, parents: ["fuentes"] });
		drive.calls.length = 0;
		const changed = await files.refresh();
		expect(drive.calls.filter((c) => c === "GET /drive/v3/changes")).toHaveLength(40);
		expect(changed).toContain("nuevo");
		expect(files.get("notas")?.name).toBe("notas 2099.txt");
		expect(await files.refresh()).toEqual([]); // and from the new point on, as usual
	});

	it("follows Drive's changes: new, renamed, moved and deleted files", async () => {
		drive = await fakeDrive(SEED);
		const files = await index(drive);
		const seen: string[][] = [];
		files.onChange((ids) => seen.push(ids));
		drive.add({ id: "nuevo", name: "Recibo.pdf", mimeType: PDF, parents: ["fuentes"], content: Buffer.from("%PDF") });
		drive.update("notas", { name: "notas del examen.txt", parents: ["uni"] });
		drive.remove("tema1");
		await files.refresh();
		expect(seen).toEqual([["nuevo", "notas", "tema1"]]);
		expect(files.pathOf("notas")).toBe("Universidad/notas del examen.txt");
		expect(files.search("estadistica")).toEqual([]);
		expect(files.filesUnder("fuentes").map((f) => f.id).sort()).toEqual(["contrato", "nuevo"]);
	});

	it("starts from its snapshot in the app's hidden folder instead of listing the whole Drive", async () => {
		drive = await fakeDrive(SEED);
		const first = await index(drive);
		expect(first.size).toBe(SEED.length);
		drive.add({ id: "nuevo", name: "Recibo.pdf", mimeType: PDF, parents: ["fuentes"] });
		drive.calls.length = 0;
		const second = await index(drive);
		expect(drive.calls.filter((c) => c === "GET /drive/v3/files")).toEqual([]); // no full listing
		expect(second.search("recibo")[0]?.id).toBe("nuevo"); // and the change since the snapshot came in
	});

	it("reads text, Google formats through their export, and other files whole", async () => {
		drive = await fakeDrive(SEED);
		const files = await index(drive, false);
		expect(await files.read("notas")).toMatchObject({ kind: "text", text: "examen en enero" });
		expect(await files.read("doc")).toMatchObject({ kind: "text", text: "Repasar estadística los lunes", mimeType: "text/plain" });
		const pdf = await files.read("tema1");
		expect(pdf.kind).toBe("binary");
		expect(pdf.kind === "binary" && pdf.data.toString()).toContain("varianza");
		const content = await files.searchContent("varianza");
		expect(content.map((h) => h.id)).toEqual(["tema1"]);
	});
});
