import { execFile } from "node:child_process";
import type { OcrRunner } from "./ocr.js";

export interface Extraction {
	/** `none` when nothing usable came out (scan without OCR, unsupported type or extractor missing). */
	method: "pdftotext" | "ocr" | "none";
	/** Text of each page, blank pages dropped but numbering kept. */
	pages: { number: number; text: string }[];
	reason?: string;
	/** pdftotext ran but found (almost) no text: probably a scan. */
	scanned?: boolean;
	/** Pages in the document, when known. */
	pageCount?: number;
	/** An image: its text goes in the note without page headings (unless it has several pages). */
	image?: boolean;
	/** Set when method is `ocr`. */
	ocr?: { languages: string; skippedPages: number; failedPages: number[] };
}

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "tif", "tiff"];

/** Below this many non-space characters in total, OCR output is noise, not text. */
const MIN_OCR_CHARS = 10;

function tidy(text: string): string {
	return text.replace(/\r/g, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

function chars(text: string): number {
	return text.replace(/\s/g, "").length;
}

/** Pages of text from a PDF with poppler's pdftotext. Local only: nothing leaves the machine. */
export function extractPdf(file: string, opts: { binary?: string; timeoutMs?: number } = {}): Promise<Extraction> {
	return new Promise((resolve) => {
		execFile(
			opts.binary ?? "pdftotext",
			["-enc", "UTF-8", file, "-"],
			{ encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000, windowsHide: true },
			(error, stdout) => {
				if (error) {
					const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
					return resolve({ method: "none", pages: [], reason: missing ? "pdftotext is not installed" : `pdftotext failed: ${error.message.split("\n")[0]}` });
				}
				const raw = stdout.replace(/\r/g, "").split("\f");
				if (raw.length > 1 && raw[raw.length - 1]?.trim() === "") raw.pop();
				const pages = raw.map((text, i) => ({ number: i + 1, text: tidy(text) }));
				const total = pages.reduce((n, p) => n + chars(p.text), 0);
				if (pages.length === 0 || total / pages.length < 20) {
					return resolve({ method: "none", pages: [], scanned: true, pageCount: pages.length, reason: "no extractable text (probably a scanned PDF)" });
				}
				resolve({ method: "pdftotext", pages: pages.filter((p) => p.text !== ""), pageCount: pages.length });
			},
		);
	});
}

/** OCR of a scanned PDF, page by page, up to the runner's page limit. A failing page is skipped, not fatal. */
async function ocrPdf(file: string, scan: Extraction, ocr: OcrRunner): Promise<Extraction> {
	const count = scan.pageCount ?? 0;
	const limit = Math.min(count, ocr.maxPages);
	const pages: Extraction["pages"] = [];
	const failedPages: number[] = [];
	for (let n = 1; n <= limit; n++) {
		try {
			const text = tidy(await ocr.pdfPage(file, n));
			if (text) pages.push({ number: n, text });
		} catch {
			failedPages.push(n);
		}
	}
	const total = pages.reduce((n, p) => n + chars(p.text), 0);
	if (total < MIN_OCR_CHARS) {
		const why = limit > 0 && failedPages.length === limit ? "OCR failed on every page" : "OCR found no text either";
		return { ...scan, reason: `no extractable text (probably a scanned PDF; ${why})` };
	}
	return { method: "ocr", pages, pageCount: count, ocr: { languages: ocr.languages, skippedPages: count - limit, failedPages } };
}

/**
 * Text of an attachment: pdftotext for PDFs, with OCR when the PDF turns out to be a scan,
 * and OCR for images. Without OCR tools the result is `none` with the reason, as before.
 */
export async function extractAttachment(file: string, ext: string, opts: { pdftotext?: string; ocr?: OcrRunner | null } = {}): Promise<Extraction> {
	const ocr = opts.ocr ?? null;
	if (ext === "pdf") {
		const text = await extractPdf(file, { binary: opts.pdftotext });
		if (text.method !== "none" || !text.scanned) return text;
		const why = ocr ? ocr.unavailable("pdf") : "OCR is not configured";
		if (why) return { ...text, reason: `${text.reason?.replace(/\)$/, "")}; OCR unavailable: ${why})` };
		return ocrPdf(file, text, ocr as OcrRunner);
	}
	if (IMAGE_EXTENSIONS.includes(ext)) {
		const why = ocr ? ocr.unavailable("image") : "OCR is not configured";
		if (why || !ocr) return { method: "none", pages: [], image: true, reason: `no text extractor for .${ext} files (OCR unavailable: ${why})` };
		let raw: string[];
		try {
			raw = await ocr.image(file);
		} catch (error) {
			return { method: "none", pages: [], image: true, reason: `OCR failed: ${String((error as Error).message ?? error).split("\n")[0]}` };
		}
		const pages = raw.map((t, i) => ({ number: i + 1, text: tidy(t) })).filter((p) => p.text !== "");
		if (pages.reduce((n, p) => n + chars(p.text), 0) < MIN_OCR_CHARS) return { method: "none", pages: [], image: true, reason: "OCR found no text in the image" };
		return { method: "ocr", pages, image: true, pageCount: raw.length, ocr: { languages: ocr.languages, skippedPages: 0, failedPages: [] } };
	}
	return { method: "none", pages: [], reason: `no text extractor for .${ext} files` };
}
