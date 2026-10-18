import { execFile, execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { extractAttachment } from "../src/extract.js";
import type { Warning } from "../src/memory.js";
import { defaultOcrSettings, detectOcr, type OcrRunner } from "../src/ocr.js";
import { makeMemory, note, tempDir, writer } from "./helpers.js";
import { makeImagePdf, makePdf, parsePgm } from "./pdf.js";

const run = promisify(execFile);

function has(binary: string, args: string[]): boolean {
	try {
		execFileSync(binary, args, { stdio: "ignore", windowsHide: true });
		return true;
	} catch (error) {
		// pdftoppm -v exits 99 on some versions: only a missing binary counts as absent.
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}
const HAS_PDFTOTEXT = has("pdftotext", ["-v"]);
const HAS_PDFTOPPM = has("pdftoppm", ["-v"]);
const HAS_TESSERACT = has("tesseract", ["--version"]);

/** A fake OCR: page n of any PDF reads `pages[n]`; a function entry may throw. */
function fakeOcr(pages: Record<number, string | (() => string)>, opts: { maxPages?: number; image?: string[]; unavailable?: string } = {}): OcrRunner & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		languages: "spa+eng",
		maxPages: opts.maxPages ?? 50,
		unavailable: () => opts.unavailable ?? null,
		pdfPage: async (_file, page) => {
			calls.push(`pdf:${page}`);
			const p = pages[page];
			return typeof p === "function" ? p() : (p ?? "");
		},
		image: async () => {
			calls.push("image");
			return opts.image ?? [];
		},
	};
}

let dir: string | null = null;
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = null;
});
async function fileWith(name: string, data: Buffer | string): Promise<string> {
	dir ??= await tempDir("mm-ocr-");
	const file = join(dir, name);
	await writeFile(file, data);
	return file;
}

describe.skipIf(!HAS_PDFTOTEXT)("extraction with OCR (fake runner)", () => {
	it("keeps pdftotext for PDFs with text and never calls OCR", async () => {
		const ocr = fakeOcr({});
		const r = await extractAttachment(await fileWith("a.pdf", makePdf(["Escritura de compraventa del piso de Oviedo"])), "pdf", { ocr });
		expect(r.method).toBe("pdftotext");
		expect(ocr.calls).toEqual([]);
	});

	it("OCRs a scanned PDF page by page, keeping page numbers", async () => {
		const ocr = fakeOcr({ 1: "Contrato de arrendamiento  \n\n\n\nfirmado en Lugo", 2: "   ", 3: "Anexo con el inventario del piso" });
		const r = await extractAttachment(await fileWith("scan.pdf", makePdf(["", "", ""])), "pdf", { ocr });
		expect(r.method).toBe("ocr");
		expect(ocr.calls).toEqual(["pdf:1", "pdf:2", "pdf:3"]);
		expect(r.pages).toEqual([
			{ number: 1, text: "Contrato de arrendamiento\n\nfirmado en Lugo" },
			{ number: 3, text: "Anexo con el inventario del piso" },
		]);
		expect(r.ocr).toEqual({ languages: "spa+eng", skippedPages: 0, failedPages: [] });
	});

	it("stops at the page limit and skips pages that fail", async () => {
		const ocr = fakeOcr({ 1: "Primera página del escaneo", 2: () => { throw new Error("timeout"); }, 3: "Tercera página del escaneo", 4: "nunca" }, { maxPages: 3 });
		const r = await extractAttachment(await fileWith("long.pdf", makePdf(["", "", "", "", ""])), "pdf", { ocr });
		expect(r.method).toBe("ocr");
		expect(ocr.calls).toEqual(["pdf:1", "pdf:2", "pdf:3"]);
		expect(r.pages.map((p) => p.number)).toEqual([1, 3]);
		expect(r.ocr).toMatchObject({ skippedPages: 2, failedPages: [2] });
		expect(r.pageCount).toBe(5);
	});

	it("falls back to `none` when OCR is missing, unavailable or finds nothing", async () => {
		const scan = await fileWith("s.pdf", makePdf([""]));
		const none = await extractAttachment(scan, "pdf", {});
		expect(none).toMatchObject({ method: "none", scanned: true });
		expect(none.reason).toBe("no extractable text (probably a scanned PDF; OCR unavailable: OCR is not configured)");
		const missing = await extractAttachment(scan, "pdf", { ocr: fakeOcr({}, { unavailable: "tesseract is not installed" }) });
		expect(missing.reason).toContain("OCR unavailable: tesseract is not installed");
		const empty = await extractAttachment(scan, "pdf", { ocr: fakeOcr({ 1: " ~ " }) });
		expect(empty.method).toBe("none");
		expect(empty.reason).toContain("OCR found no text either");
		const failing = await extractAttachment(scan, "pdf", { ocr: fakeOcr({ 1: () => { throw new Error("boom"); } }) });
		expect(failing.reason).toContain("OCR failed on every page");
	});

	it("OCRs images and leaves other types alone", async () => {
		const png = await fileWith("ticket.png", "not really a png");
		const r = await extractAttachment(png, "png", { ocr: fakeOcr({}, { image: ["Ticket de compra\nTotal 12,50 €\n"] }) });
		expect(r).toMatchObject({ method: "ocr", image: true, pages: [{ number: 1, text: "Ticket de compra\nTotal 12,50 €" }] });
		const noOcr = await extractAttachment(png, "png", {});
		expect(noOcr).toMatchObject({ method: "none", reason: "no text extractor for .png files (OCR unavailable: OCR is not configured)" });
		const blank = await extractAttachment(png, "jpg", { ocr: fakeOcr({}, { image: ["  .  "] }) });
		expect(blank).toMatchObject({ method: "none", reason: "OCR found no text in the image" });
		const docx = await extractAttachment(png, "docx", { ocr: fakeOcr({}) });
		expect(docx).toEqual({ method: "none", pages: [], reason: "no text extractor for .docx files" });
	});
});

describe.skipIf(!HAS_PDFTOTEXT)("attach with OCR", () => {
	let env: Awaited<ReturnType<typeof makeMemory>> | null = null;
	afterEach(async () => {
		await env?.cleanup();
		env = null;
	});

	it("writes OCR'd pages as sections of the companion note, says it is OCR, and makes them searchable", async () => {
		const ocr = fakeOcr({ 1: "Contrato de arrendamiento firmado en Lugo", 2: "Fianza de dos mensualidades" });
		env = await makeMemory({ "temas/nada.md": note("Nada", "Relleno") }, { ocr });
		const r = await env.memory.attach(writer, { path: "temas/contrato-lugo.pdf", source: { base64: makePdf(["", ""]).toString("base64") }, title: "Contrato de Lugo", description: "Contrato escaneado", reason: "Adjuntar contrato" });
		expect(r).toMatchObject({ path: "temas/contrato-lugo.md", pages: 2, extracted_with: "ocr" });
		expect(r.warnings.map((w) => w.code)).not.toContain("EXTRACTION_EMPTY");
		const content = (await env.memory.read({ path: "temas/contrato-lugo.md" })).content as string;
		expect(content).toContain("extracted_with: ocr");
		expect(content).toContain("> Text recognised with OCR (spa+eng); it may contain errors.");
		expect(content).toContain("## Página 1\n\nContrato de arrendamiento firmado en Lugo\n");
		expect(content).toContain("## Página 2\n\nFianza de dos mensualidades\n");
		expect(JSON.stringify(env.memory.search({ query: "fianza mensualidades" }))).toContain("temas/contrato-lugo.md");
	});

	it("uses the repo's ocr_notice and warns when only part of a scan was OCR'd", async () => {
		const ocr = fakeOcr({ 1: "Primera hoja de la escritura" }, { maxPages: 1 });
		env = await makeMemory({ "memory.toml": `[folders]\nallowed = ["temas"]\n\n[attachments]\npage_heading = "Página {n}"\nocr_notice = "Texto reconocido por OCR ({languages})."\n` }, { ocr });
		const r = await env.memory.attach(writer, { path: "temas/escritura.pdf", source: { base64: makePdf(["", "", ""]).toString("base64") }, description: "Escritura escaneada", reason: "Adjuntar" });
		const partial = r.warnings.find((w) => w.code === "EXTRACTION_PARTIAL") as Warning;
		expect(partial).toMatchObject({ skipped_pages: 2, failed_pages: [] });
		expect(partial.message).toContain("the last 2 of 3 pages");
		const content = (await env.memory.read({ path: "temas/escritura.md" })).content as string;
		expect(content).toContain("> Texto reconocido por OCR (spa+eng).");
	});

	it("keeps EXTRACTION_EMPTY for scans when OCR is unavailable, saying why", async () => {
		env = await makeMemory({}, { ocr: fakeOcr({}, { unavailable: "tesseract is not installed" }) });
		const r = await env.memory.attach(writer, { path: "temas/escaneo.pdf", source: { base64: makePdf([""]).toString("base64") }, description: "Un escaneo", reason: "Escaneo" });
		const empty = r.warnings.find((w) => w.code === "EXTRACTION_EMPTY") as Warning;
		expect(empty.message).toBe("No text was extracted: no extractable text (probably a scanned PDF; OCR unavailable: tesseract is not installed).");
		expect(r).toMatchObject({ pages: 0, extracted_with: "none" });
	});

	it("OCRs an image into its companion note without page headings", async () => {
		env = await makeMemory({}, { ocr: fakeOcr({}, { image: ["Ticket de la ferretería\nTotal 12,50 €"] }) });
		const r = await env.memory.attach(writer, { path: "temas/ticket-ferreteria.jpg", source: { base64: Buffer.from("jpeg bytes").toString("base64") }, title: "Ticket", description: "Ticket de compra", reason: "Ticket" });
		expect(r).toMatchObject({ pages: 1, extracted_with: "ocr", warnings: [] });
		const content = (await env.memory.read({ path: "temas/ticket-ferreteria.md" })).content as string;
		expect(content).toContain("![[ticket-ferreteria.jpg]]\n\n> Text recognised with OCR (spa+eng); it may contain errors.\n\nTicket de la ferretería\nTotal 12,50 €\n");
		expect(content).not.toContain("## Página");
	});

	it("attaches an image without OCR as before: EXTRACTION_EMPTY", async () => {
		env = await makeMemory({});
		const r = await env.memory.attach(writer, { path: "temas/foto.png", source: { base64: Buffer.from("png bytes").toString("base64") }, description: "Una foto", reason: "Foto" });
		expect(r.warnings.find((w) => w.code === "EXTRACTION_EMPTY")?.message).toBe("No text was extracted: no text extractor for .png files (OCR unavailable: OCR is not configured).");
	});
});

describe("OCR tools and config", () => {
	it("reports missing tools without throwing, and logs what it found", async () => {
		const events: [string, string, Record<string, unknown> | undefined][] = [];
		const ocr = await detectOcr({ ...defaultOcrSettings, tesseract: "no-such-tesseract-binary", pdftoppm: "no-such-pdftoppm-binary" }, (level, event, fields) => events.push([level, event, fields]));
		expect(ocr.unavailable("image")).toBe("tesseract is not installed");
		expect(ocr.unavailable("pdf")).toBe("tesseract is not installed");
		expect(events).toEqual([["warn", "ocr.tools", expect.objectContaining({ enabled: true, tesseract: false, pdftoppm: false, pdf: false, image: false })]]);
	});

	it("is unavailable when disabled, without probing", async () => {
		const ocr = await detectOcr({ ...defaultOcrSettings, enabled: false, tesseract: "no-such-binary" });
		expect(ocr.unavailable("pdf")).toBe("OCR is disabled in the configuration");
	});

	it("reads [ocr] from config.toml with defaults", async () => {
		dir = await tempDir("mm-cfg-");
		const base = `[listen.private]\nport = 8782\n`;
		await writeFile(join(dir, "a.toml"), base);
		expect(loadConfig(join(dir, "a.toml")).ocr).toEqual(defaultOcrSettings);
		await writeFile(join(dir, "b.toml"), `${base}\n[ocr]\nenabled = false\nlanguages = "spa+eng"\nmax_pages = 10\npage_timeout_seconds = 30\n`);
		expect(loadConfig(join(dir, "b.toml")).ocr).toMatchObject({ enabled: false, languages: "spa+eng", maxPages: 10, pageTimeoutSeconds: 30, dpi: 300 });
		await writeFile(join(dir, "c.toml"), `${base}\n[ocr]\nlanguages = "spa eng"\n`);
		expect(() => loadConfig(join(dir as string, "c.toml"))).toThrow(/ocr.languages/);
		await writeFile(join(dir, "d.toml"), `${base}\n[ocr]\nmax_pages = 0\n`);
		expect(() => loadConfig(join(dir as string, "d.toml"))).toThrow(/ocr.max_pages/);
	});
});

describe.skipIf(!HAS_PDFTOPPM || !HAS_PDFTOTEXT)("scan fixture", () => {
	it("a rendered page wrapped as an image is a scan to pdftotext", async () => {
		const textPdf = await fileWith("text.pdf", makePdf(["INVOICE NUMBER 4821"]));
		const prefix = join(dir as string, "render");
		await run("pdftoppm", ["-r", "50", "-gray", "-singlefile", textPdf, prefix]);
		const pgm = parsePgm(await readFile(`${prefix}.pgm`));
		expect(pgm.gray.length).toBe(pgm.width * pgm.height);
		const scan = await fileWith("scan.pdf", makeImagePdf(pgm.width, pgm.height, pgm.gray, 50));
		const ocr = fakeOcr({ 1: "INVOICE NUMBER 4821" });
		const r = await extractAttachment(scan, "pdf", { ocr });
		expect(r).toMatchObject({ method: "ocr", pageCount: 1 });
	});
});

// Real tools: runs only where tesseract (with English data), pdftoppm and pdftotext are installed.
describe.skipIf(!HAS_TESSERACT || !HAS_PDFTOPPM || !HAS_PDFTOTEXT)("OCR with tesseract (integration)", () => {
	it("reads a scanned PDF and an image", async () => {
		const ocr = await detectOcr({ ...defaultOcrSettings, languages: "eng" });
		if (ocr.unavailable("pdf")) return; // e.g. no English language data
		// Render a text PDF to a grayscale bitmap, then wrap the bitmap alone in a PDF: a scan.
		const textPdf = await fileWith("text.pdf", makePdf(["INVOICE NUMBER 4821 FROM ACME BUILDERS"]));
		const prefix = join(dir as string, "render");
		await run("pdftoppm", ["-r", "150", "-gray", "-singlefile", textPdf, prefix]);
		const pgm = parsePgm(await readFile(`${prefix}.pgm`));
		const scan = await fileWith("scan.pdf", makeImagePdf(pgm.width, pgm.height, pgm.gray));
		const fromPdf = await extractAttachment(scan, "pdf", { ocr });
		expect(fromPdf.method).toBe("ocr");
		expect(fromPdf.pages[0]?.text).toMatch(/INVOICE/);
		expect(fromPdf.pages[0]?.text).toMatch(/4821/);
		await run("pdftoppm", ["-r", "150", "-png", "-singlefile", textPdf, prefix]);
		const fromImage = await extractAttachment(`${prefix}.png`, "png", { ocr });
		expect(fromImage.method).toBe("ocr");
		expect(fromImage.pages[0]?.text).toMatch(/ACME/);
	}, 60_000);
});
