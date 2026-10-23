import { gunzipSync } from "node:zlib";

/** One regular file of a tarball. */
export interface TarFile {
	path: string;
	data: Buffer;
}

const BLOCK = 512;

function field(header: Buffer, start: number, length: number): string {
	const raw = header.subarray(start, start + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(header: Buffer, start: number, length: number): number {
	const text = field(header, start, length).trim();
	return text ? Number.parseInt(text, 8) : 0;
}

/** `key=value` records of a pax extended header ("<length> key=value\n" each). */
function paxRecords(data: Buffer): Record<string, string> {
	const records: Record<string, string> = {};
	let at = 0;
	while (at < data.length) {
		const space = data.indexOf(0x20, at);
		if (space === -1) break;
		const length = Number.parseInt(data.subarray(at, space).toString("utf8"), 10);
		if (!Number.isFinite(length) || length <= 0) break;
		const record = data.subarray(space + 1, at + length - 1).toString("utf8");
		const eq = record.indexOf("=");
		if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
		at += length;
	}
	return records;
}

/**
 * The regular files of a .tar.gz, such as the one GitHub serves for a commit. `stripComponents` drops leading path
 * parts (GitHub puts everything under `<owner>-<repo>-<sha>/`). Handles ustar names (prefix + name), GNU long names
 * and pax `path` records, which is what git archive writes.
 */
export function readTarGz(gz: Buffer, stripComponents = 0): TarFile[] {
	const tar = gunzipSync(gz);
	const files: TarFile[] = [];
	let longName: string | null = null;
	let pax: Record<string, string> = {};
	for (let at = 0; at + BLOCK <= tar.length; ) {
		const header = tar.subarray(at, at + BLOCK);
		if (header.every((b) => b === 0)) break;
		const size = octal(header, 124, 12);
		const type = String.fromCharCode(header[156] ?? 0x30);
		const dataStart = at + BLOCK;
		const data = tar.subarray(dataStart, dataStart + size);
		at = dataStart + Math.ceil(size / BLOCK) * BLOCK;
		if (type === "x") {
			pax = paxRecords(data);
			continue;
		}
		if (type === "g") continue; // global header (git archive puts the commit id there)
		if (type === "L") {
			longName = data.toString("utf8").replace(/\0+$/, "");
			continue;
		}
		const prefix = field(header, 345, 155);
		let path = pax.path ?? longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
		longName = null;
		pax = {};
		if (type !== "0" && type !== "\0" && type !== "7") continue; // only regular files (no dirs, links)
		path = path.split("/").filter(Boolean).slice(stripComponents).join("/");
		if (path) files.push({ path, data: Buffer.from(data) });
	}
	return files;
}
