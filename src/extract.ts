import { execFile } from "node:child_process";

export interface Extraction {
	/** `none` when nothing usable came out (scanned PDF, unsupported type or extractor missing). */
	method: "pdftotext" | "none";
	/** Text of each page, blank pages dropped but numbering kept. */
	pages: { number: number; text: string }[];
	reason?: string;
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
				const pages = raw.map((text, i) => ({ number: i + 1, text: text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() }));
				const chars = pages.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0);
				if (pages.length === 0 || chars / pages.length < 20) {
					return resolve({ method: "none", pages: [], reason: "no extractable text (probably a scanned PDF; OCR is not available yet)" });
				}
				resolve({ method: "pdftotext", pages: pages.filter((p) => p.text !== "") });
			},
		);
	});
}
