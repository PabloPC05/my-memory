/**
 * The text of a PDF in pure JavaScript (pdf.js through unpdf), for hosts without `pdftotext` and for models that do
 * not take PDFs: one block per page, headed `[Page n]`. Null when the PDF has no text layer (a scan) or cannot be read.
 */
export async function pdfText(data: Buffer): Promise<string | null> {
	try {
		const { extractText, getDocumentProxy } = await import("unpdf");
		const pdf = await getDocumentProxy(new Uint8Array(data));
		const { text } = await extractText(pdf, { mergePages: false });
		const pages = (text as string[]).map((t, i) => `[Page ${i + 1}]\n${t.trim()}`);
		return pages.some((p) => p.length > 12) ? pages.join("\n\n") : null;
	} catch {
		return null;
	}
}
