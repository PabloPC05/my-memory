/** A minimal valid PDF with one text line per page (empty string = page without text, like a scan). */
export function makePdf(pages: string[]): Buffer {
	const objects: string[] = [];
	const add = (body: string) => {
		objects.push(body);
		return objects.length;
	};
	const catalog = add("");
	const pagesObj = add("");
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids: number[] = [];
	for (const text of pages) {
		const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
		const stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : "";
		const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
		kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
	}
	objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
	objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(Buffer.byteLength(out, "latin1"));
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out, "latin1");
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

/** A one-page PDF holding only an 8-bit grayscale image (`gray` is width×height bytes): a scan, for pdftotext. */
export function makeImagePdf(width: number, height: number, gray: Buffer, dpi = 150): Buffer {
	const w = (width * 72) / dpi;
	const h = (height * 72) / dpi;
	const content = `q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>`,
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${gray.length} >>\nstream\n${gray.toString("latin1")}\nendstream`,
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(Buffer.byteLength(out, "latin1"));
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out, "latin1");
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

/** Reads a binary PGM (P5, maxval 255), as written by `pdftoppm -gray`. */
export function parsePgm(file: Buffer): { width: number; height: number; gray: Buffer } {
	const header = file.subarray(0, 64).toString("latin1");
	const m = /^P5\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+(\d+)\s/.exec(header);
	if (!m) throw new Error("not a binary PGM");
	const width = Number(m[1]);
	const height = Number(m[2]);
	return { width, height, gray: file.subarray(m[0].length, m[0].length + width * height) };
}
