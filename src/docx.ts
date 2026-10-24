import { inflateRawSync } from "node:zlib";

/** The files of a zip archive (stored or deflated entries), by name. Enough for Office documents. */
export function readZip(data: Buffer): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	// End of central directory: the last 22+ bytes, signature 0x06054b50.
	let eocd = -1;
	for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
		if (data.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd === -1) throw new Error("not a zip file");
	const count = data.readUInt16LE(eocd + 10);
	let at = data.readUInt32LE(eocd + 16);
	for (let n = 0; n < count && at + 46 <= data.length; n++) {
		if (data.readUInt32LE(at) !== 0x02014b50) break;
		const method = data.readUInt16LE(at + 10);
		const compressed = data.readUInt32LE(at + 20);
		const nameLength = data.readUInt16LE(at + 28);
		const extraLength = data.readUInt16LE(at + 30);
		const commentLength = data.readUInt16LE(at + 32);
		const local = data.readUInt32LE(at + 42);
		const name = data.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		at += 46 + nameLength + extraLength + commentLength;
		const localName = data.readUInt16LE(local + 26);
		const localExtra = data.readUInt16LE(local + 28);
		const start = local + 30 + localName + localExtra;
		const raw = data.subarray(start, start + compressed);
		if (method === 0) files.set(name, Buffer.from(raw));
		else if (method === 8) files.set(name, inflateRawSync(raw));
	}
	return files;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, _n, dec, hex) => (dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : (ENTITIES[m] ?? m)));

/** The plain text of a Word document (.docx): one line per paragraph, tabs and line breaks kept. */
export function docxText(data: Buffer): string {
	const xml = readZip(data).get("word/document.xml")?.toString("utf8");
	if (!xml) throw new Error("not a Word document (no word/document.xml)");
	return xml
		.split(/<\/w:p>/)
		.map((p) =>
			[...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br)\b[^>]*\/>/g)]
				.map((m) => (m[2] === "tab" ? "\t" : m[2] === "br" ? "\n" : unescape(m[1] ?? "")))
				.join(""),
		)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
