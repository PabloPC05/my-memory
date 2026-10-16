import { existsSync, readFileSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { randomToken, safeEqual, sha256 } from "../util.js";

export interface StaticToken {
	/** Stable id: commit trailer and author email local part. */
	id: string;
	/** Commit author name. */
	name: string;
	scope: "read" | "write";
	/** `sha256:<hex>` of the token. The token itself is never stored. */
	hash: string;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseTokens(text: string): StaticToken[] {
	const doc = parseToml(text) as { token?: unknown };
	const list = doc.token ?? [];
	if (!Array.isArray(list)) throw new Error("tokens file: [[token]] entries expected");
	const seen = new Set<string>();
	return list.map((t, i) => {
		const e = t as Record<string, unknown>;
		if (typeof e.id !== "string" || !ID.test(e.id)) throw new Error(`tokens file: entry ${i} has an invalid id`);
		if (seen.has(e.id)) throw new Error(`tokens file: duplicate id «${e.id}»`);
		seen.add(e.id);
		if (e.scope !== "read" && e.scope !== "write") throw new Error(`tokens file: «${e.id}» scope must be read or write`);
		if (typeof e.hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(e.hash)) throw new Error(`tokens file: «${e.id}» has an invalid hash`);
		return { id: e.id, name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : e.id, scope: e.scope, hash: e.hash };
	});
}

/** Static Bearer tokens, one per client, read from a TOML file. Reloaded on SIGHUP. */
export class TokenStore {
	private tokens: StaticToken[] = [];

	constructor(readonly file: string | null) {
		this.reload();
	}

	reload(): void {
		if (!this.file || !existsSync(this.file)) {
			this.tokens = [];
			return;
		}
		this.tokens = parseTokens(readFileSync(this.file, "utf8"));
	}

	verify(token: string): StaticToken | null {
		const hash = `sha256:${sha256(token)}`;
		return this.tokens.find((t) => safeEqual(t.hash, hash)) ?? null;
	}

	get count(): number {
		return this.tokens.length;
	}
}

async function load(file: string): Promise<StaticToken[]> {
	return existsSync(file) ? parseTokens(await readFile(file, "utf8")) : [];
}

async function save(file: string, tokens: StaticToken[]): Promise<void> {
	const tmp = `${file}.tmp`;
	await writeFile(tmp, `# my-memory static tokens. Only hashes are stored; manage with \`my-memory token\`.\n${stringifyToml({ token: tokens })}\n`, { mode: 0o640 });
	await chmod(tmp, 0o640).catch(() => undefined);
	await rename(tmp, file);
}

export async function addToken(file: string, id: string, name: string, scope: "read" | "write"): Promise<string> {
	if (!ID.test(id)) throw new Error("id: lowercase letters, digits, dot, dash or underscore; up to 64 characters");
	const tokens = await load(file);
	if (tokens.some((t) => t.id === id)) throw new Error(`a token with id «${id}» already exists; revoke it first`);
	const token = randomToken("mm_");
	tokens.push({ id, name: name.trim() || id, scope, hash: `sha256:${sha256(token)}` });
	await save(file, tokens);
	return token;
}

export async function listTokens(file: string): Promise<Omit<StaticToken, "hash">[]> {
	return (await load(file)).map(({ hash: _, ...t }) => t);
}

export async function revokeToken(file: string, id: string): Promise<boolean> {
	const tokens = await load(file);
	const kept = tokens.filter((t) => t.id !== id);
	if (kept.length === tokens.length) return false;
	await save(file, kept);
	return true;
}
