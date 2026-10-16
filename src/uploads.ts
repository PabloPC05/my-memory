import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { MemoryError } from "./errors.js";

export interface UploadMeta {
	id: string;
	filename: string;
	size: number;
	sha256: string;
	clientId: string;
	createdAt: string;
}

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Uploads waiting for `attach`. Bodies are streamed to disk: no size limit beyond free space. */
export class UploadStore {
	constructor(
		readonly dir: string,
		private readonly opts: { minFreeBytes?: number; ttlMs?: number } = {},
	) {}

	async init(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
	}

	/** Free space check before accepting a body of `declared` bytes (when the client says). */
	async hasRoomFor(declared: number | null): Promise<boolean> {
		try {
			const s = await statfs(this.dir);
			const free = s.bavail * s.bsize;
			return free >= (this.opts.minFreeBytes ?? 2 * 1024 ** 3) + (declared ?? 0);
		} catch {
			return true;
		}
	}

	async receive(body: Readable, filename: string, clientId: string): Promise<UploadMeta> {
		const id = randomBytes(18).toString("base64url");
		const part = join(this.dir, `${id}.part`);
		const hash = createHash("sha256");
		let size = 0;
		const meter = new Transform({
			transform(chunk: Buffer, _enc, cb) {
				size += chunk.length;
				hash.update(chunk);
				cb(null, chunk);
			},
		});
		try {
			await pipeline(body, meter, createWriteStream(part, { flags: "wx" }));
		} catch (error) {
			await rm(part, { force: true });
			throw error;
		}
		const meta: UploadMeta = { id, filename, size, sha256: hash.digest("hex"), clientId, createdAt: new Date().toISOString() };
		await rename(part, join(this.dir, id));
		await writeFile(join(this.dir, `${id}.json`), JSON.stringify(meta));
		return meta;
	}

	/** Writes a base64 payload as an upload, so `attach` has one code path. */
	async fromBase64(data: string, filename: string, clientId: string): Promise<UploadMeta> {
		const clean = data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean) || clean.length === 0) throw new MemoryError("INVALID_BASE64", "The base64 payload is not valid.");
		const buf = Buffer.from(clean, "base64");
		const { Readable } = await import("node:stream");
		return this.receive(Readable.from([buf]), filename, clientId);
	}

	async get(id: string): Promise<{ meta: UploadMeta; file: string }> {
		if (!ID.test(id)) throw new MemoryError("UPLOAD_NOT_FOUND", `Unknown upload «${id}».`);
		try {
			const meta = JSON.parse(await readFile(join(this.dir, `${id}.json`), "utf8")) as UploadMeta;
			await stat(join(this.dir, id));
			return { meta, file: join(this.dir, id) };
		} catch {
			throw new MemoryError("UPLOAD_NOT_FOUND", `Unknown or expired upload «${id}».`);
		}
	}

	async remove(id: string): Promise<void> {
		if (!ID.test(id)) return;
		await rm(join(this.dir, id), { force: true });
		await rm(join(this.dir, `${id}.json`), { force: true });
	}

	/** Deletes uploads older than the TTL (24 h by default) and leftover partial files. */
	async sweep(now = Date.now()): Promise<number> {
		let removed = 0;
		for (const entry of await readdir(this.dir)) {
			const full = join(this.dir, entry);
			const info = await stat(full).catch(() => null);
			if (!info) continue;
			if (now - info.mtimeMs > (this.opts.ttlMs ?? DAY_MS)) {
				await rm(full, { force: true });
				removed++;
			}
		}
		return removed;
	}
}
