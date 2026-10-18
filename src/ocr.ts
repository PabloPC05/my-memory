import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Logger, silentLogger } from "./log.js";

export interface OcrSettings {
	enabled: boolean;
	/** Tesseract languages joined with `+`, e.g. `spa+eng`. */
	languages: string;
	/** Pages of a scanned PDF that are OCR'd; the rest is left out (and the note says so). */
	maxPages: number;
	/** Limit for rendering plus recognising one page (or one image). */
	pageTimeoutSeconds: number;
	dpi: number;
	tesseract: string;
	pdftoppm: string;
}

export const defaultOcrSettings: OcrSettings = {
	enabled: true,
	languages: "eng",
	maxPages: 50,
	pageTimeoutSeconds: 120,
	dpi: 300,
	tesseract: "tesseract",
	pdftoppm: "pdftoppm",
};

/**
 * What `attach` needs from OCR. The real one runs pdftoppm and tesseract; tests pass a fake.
 * Each call returns the recognised text or throws; it never leaves files behind.
 */
export interface OcrRunner {
	/** Languages actually used (requested ones that are installed). */
	readonly languages: string;
	readonly maxPages: number;
	/** Why OCR cannot run for this kind of file, or null when it can. */
	unavailable(kind: "pdf" | "image"): string | null;
	/** Text of one page (1-based) of a PDF. */
	pdfPage(file: string, page: number): Promise<string>;
	/** Text of an image; one entry per page (multi-page TIFF). */
	image(file: string): Promise<string[]>;
}

function run(binary: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(binary, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
			if (error) return reject(error);
			resolve(stdout);
		});
	});
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Tesseract's text output: pages separated by form feeds. */
function splitPages(stdout: string): string[] {
	const pages = stdout.replace(/\r/g, "").split("\f");
	if (pages.length > 1 && pages[pages.length - 1]?.trim() === "") pages.pop();
	return pages;
}

class TesseractRunner implements OcrRunner {
	constructor(
		private readonly settings: OcrSettings,
		readonly languages: string,
		private readonly problems: { pdf: string | null; image: string | null },
	) {}

	get maxPages(): number {
		return this.settings.maxPages;
	}

	unavailable(kind: "pdf" | "image"): string | null {
		return this.problems[kind];
	}

	private get timeoutMs(): number {
		return this.settings.pageTimeoutSeconds * 1000;
	}

	async pdfPage(file: string, page: number): Promise<string> {
		// One temp dir per page: the PNG of a 300 dpi page can be tens of MB, so it never outlives its page.
		const dir = await mkdtemp(join(tmpdir(), "my-memory-ocr-"));
		try {
			const prefix = join(dir, "page");
			const n = String(page);
			await run(this.settings.pdftoppm, ["-r", String(this.settings.dpi), "-png", "-f", n, "-l", n, "-singlefile", file, prefix], this.timeoutMs);
			const [text] = splitPages(await run(this.settings.tesseract, [`${prefix}.png`, "stdout", "-l", this.languages], this.timeoutMs));
			return text ?? "";
		} finally {
			await rm(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	}

	async image(file: string): Promise<string[]> {
		return splitPages(await run(this.settings.tesseract, [file, "stdout", "-l", this.languages], this.timeoutMs));
	}
}

/**
 * Probes pdftoppm and tesseract (and tesseract's installed languages) once, at startup.
 * Never throws: missing tools only make OCR unavailable, and the reason is logged and reported by `attach`.
 */
export async function detectOcr(settings: OcrSettings, log: Logger = silentLogger): Promise<OcrRunner> {
	if (!settings.enabled) {
		log("info", "ocr.tools", { enabled: false });
		return new TesseractRunner(settings, settings.languages, { pdf: "OCR is disabled in the configuration", image: "OCR is disabled in the configuration" });
	}
	const probe = async (binary: string, args: string[]): Promise<{ ok: boolean; out: string; error?: string }> => {
		try {
			return { ok: true, out: await run(binary, args, 15_000) };
		} catch (error) {
			const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
			// `pdftoppm -v` exits 0 or 99 depending on the version; finding the binary is what matters.
			if (!missing(error) && /pdftoppm/i.test(`${e.stdout ?? ""}${e.stderr ?? ""}`)) return { ok: true, out: "" };
			return { ok: false, out: "", error: missing(error) ? "not installed" : String(e.message).split("\n")[0] };
		}
	};
	const [tess, langs, ppm] = await Promise.all([
		probe(settings.tesseract, ["--version"]),
		probe(settings.tesseract, ["--list-langs"]),
		probe(settings.pdftoppm, ["-v"]),
	]);
	const installed = langs.ok ? langs.out.replace(/\r/g, "").split("\n").slice(1).map((l) => l.trim()).filter(Boolean) : [];
	const requested = settings.languages.split("+").map((l) => l.trim()).filter(Boolean);
	const usable = requested.filter((l) => installed.includes(l));
	const missingLangs = requested.filter((l) => !installed.includes(l));
	let tessProblem: string | null = null;
	if (!tess.ok) tessProblem = `tesseract is ${tess.error === "not installed" ? "not installed" : `not working (${tess.error})`}`;
	else if (usable.length === 0) tessProblem = `none of the OCR languages «${settings.languages}» is installed for tesseract`;
	const pdfProblem = tessProblem ?? (ppm.ok ? null : `pdftoppm is ${ppm.error === "not installed" ? "not installed" : `not working (${ppm.error})`}`);
	const languages = usable.join("+") || settings.languages;
	log(tessProblem || pdfProblem ? "warn" : "info", "ocr.tools", {
		enabled: true,
		tesseract: tess.ok,
		pdftoppm: ppm.ok,
		languages,
		missing_languages: missingLangs,
		pdf: pdfProblem === null,
		image: tessProblem === null,
	});
	return new TesseractRunner(settings, languages, { pdf: pdfProblem, image: tessProblem });
}
