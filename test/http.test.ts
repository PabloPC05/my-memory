import { createHash, createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForgejoOAuthProvider } from "../src/auth/oauth.js";
import { addToken, TokenStore } from "../src/auth/tokens.js";
import { privateApp, publicApp } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import { UploadStore } from "../src/uploads.js";
import { makeMemory, note } from "./helpers.js";
import { makePdf } from "./pdf.js";

function listen(app: express.Express): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = app.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
	});
}

let env: Awaited<ReturnType<typeof makeMemory>>;
let priv: { server: Server; url: string };
let pub: { server: Server; url: string };
let forgejo: { server: Server; url: string };
let oauth: ForgejoOAuthProvider;
let writeToken: string;
let readToken: string;
const WEBHOOK_SECRET = "s3cret";
let forgejoUser = { login: "alex", full_name: "Alex García" };

beforeAll(async () => {
	env = await makeMemory({ "yo/perfil.md": note("Perfil", "Quién es", "Le gusta el café.") });
	const tokensFile = join(env.root, "tokens.toml");
	writeToken = await addToken(tokensFile, "claude-surface", "Claude Code (Surface)", "write");
	readToken = await addToken(tokensFile, "omb-lector", "Bot lector", "read");
	const tokens = new TokenStore(tokensFile);

	// Fake Forgejo: token exchange and user lookup.
	const f = express();
	f.use(express.urlencoded({ extended: false }));
	f.post("/login/oauth/access_token", (req, res) => {
		if (req.body.code !== "upstream-code" || req.body.client_secret !== "forgejo-secret") return void res.status(400).json({ error: "bad" });
		res.json({ access_token: "forgejo-access" });
	});
	f.get("/api/v1/user", (req, res) => {
		if (req.header("authorization") !== "Bearer forgejo-access") return void res.status(401).end();
		res.json(forgejoUser);
	});
	forgejo = await listen(f);

	const placeholder = await listen(express());
	const publicUrl = placeholder.url;
	placeholder.server.close();
	oauth = new ForgejoOAuthProvider(join(env.root, "state.sqlite"), {
		publicUrl,
		forgejoUrl: forgejo.url,
		forgejoInternalUrl: forgejo.url,
		clientId: "forgejo-client",
		clientSecret: "forgejo-secret",
		allowedUsers: ["alex"],
	});
	const uploads = new UploadStore(join(env.root, "data", "uploads"));
	await uploads.init();
	(env.memory.opts as { uploads: UploadStore }).uploads = uploads;
	priv = await listen(privateApp({ memory: env.memory, tokens, oauth, uploads, webhookSecret: WEBHOOK_SECRET, log: silentLogger }));
	const pubApp = publicApp({ memory: env.memory, oauth, publicUrl, log: silentLogger });
	const port = Number(new URL(publicUrl).port);
	pub = await new Promise((resolve) => {
		const server = pubApp.listen(port, "127.0.0.1", () => resolve({ server, url: publicUrl }));
	});
});

afterAll(async () => {
	for (const s of [priv, pub, forgejo]) await new Promise((r) => s?.server.close(r));
	oauth?.close();
	await env?.cleanup();
});

async function mcp(url: string, token: string, session?: string): Promise<Client> {
	const client = new Client({ name: "test", version: "1" });
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	if (session) headers["x-memory-session"] = session;
	await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers } }));
	return client;
}

function parse(result: unknown): Record<string, unknown> {
	const r = result as { content: { text: string }[]; isError?: boolean };
	return { ...(JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>), ...(r.isError ? { isError: true } : {}) };
}

describe("private listener", () => {
	it("serves MCP with static tokens: instructions, tools by scope, attributed writes", async () => {
		const client = await mcp(priv.url, writeToken, "chat-7");
		expect(client.getInstructions()).toContain("[[perfil]]");
		const tools = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(tools).toEqual(["attach", "create", "delete", "edit", "history", "links", "lint", "list", "move", "read", "recent", "resume", "revert", "search", "write"]);
		const created = parse(await client.callTool({ name: "create", arguments: { path: "personas/sara.md", content: note("Sara", "Amiga", "Le gusta el té."), reason: "Nueva" } }));
		expect(created.commit).toBeTruthy();
		const hist = parse(await client.callTool({ name: "history", arguments: { name: "sara" } })) as { commits: { author: string; trailers: Record<string, string> }[] };
		expect(hist.commits[0]?.author).toBe("Claude Code (Surface)");
		expect(hist.commits[0]?.trailers).toMatchObject({ Client: "claude-surface", Tool: "create", Session: "chat-7" });
		const recent = parse(await client.callTool({ name: "recent", arguments: { limit: 1 } })) as { commits: { commit: string; client: string; tool: string; notes: unknown[] }[] };
		expect(recent.commits[0]).toMatchObject({ commit: created.commit, client: "claude-surface", tool: "create", notes: [{ path: "personas/sara.md", name: "sara", change: "added" }] });
		const undone = parse(await client.callTool({ name: "revert", arguments: { commit: created.commit, reason: "Deshacer" } }));
		expect(undone).toMatchObject({ reverted: created.commit, changes: [{ path: "personas/sara.md", change: "removed" }] });
		const err = parse(await client.callTool({ name: "read", arguments: { name: "nadie" } }));
		expect(err).toMatchObject({ isError: true, code: "NOT_FOUND" });
		await client.close();
	});

	it("gives read-only tokens only the read tools", async () => {
		const client = await mcp(priv.url, readToken);
		const tools = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(tools).toEqual(["history", "links", "lint", "list", "read", "recent", "resume", "search"]);
		const hits = parse(await client.callTool({ name: "search", arguments: { query: "café" } })) as { hits: { path: string }[] };
		expect(hits.hits[0]?.path).toBe("yo/perfil.md");
		const lint = parse(await client.callTool({ name: "lint", arguments: { kinds: ["stale", "oversized"] } }));
		expect(lint).toMatchObject({ counts: { stale: 0, oversized: 0 }, items: [] });
		const bad = (await client.callTool({ name: "lint", arguments: { kinds: ["nope"] } })) as { isError?: boolean };
		expect(bad.isError).toBe(true);
		await client.close();
	});

	it("rejects missing or unknown tokens", async () => {
		const r = await fetch(`${priv.url}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
		expect(r.status).toBe(401);
		const r2 = await fetch(`${priv.url}/mcp`, { method: "POST", body: "{}" });
		expect(r2.status).toBe(401);
	});

	it("uploads without a size limit and attaches a PDF with its text", async () => {
		const pdf = makePdf(["Escritura de compraventa del piso", "Notario en Oviedo, 2026"]);
		const up = await fetch(`${priv.url}/uploads/escritura.pdf`, { method: "PUT", headers: { authorization: `Bearer ${writeToken}` }, body: pdf });
		expect(up.status).toBe(201);
		const meta = (await up.json()) as { upload_id: string; size: number; sha256: string };
		expect(meta.size).toBe(pdf.length);
		expect(meta.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
		const ro = await fetch(`${priv.url}/uploads/x.pdf`, { method: "PUT", headers: { authorization: `Bearer ${readToken}` }, body: "x" });
		expect(ro.status).toBe(403);
		const client = await mcp(priv.url, writeToken);
		const att = parse(await client.callTool({ name: "attach", arguments: { path: "temas/escritura-piso.pdf", upload_id: meta.upload_id, title: "Escritura del piso", description: "Escritura de compraventa del piso de Oviedo", reason: "Adjuntar escritura" } }));
		expect(att).toMatchObject({ path: "temas/escritura-piso.md", attachment: "temas/escritura-piso.pdf", pages: 2 });
		const read = parse(await client.callTool({ name: "read", arguments: { name: "escritura-piso" } })) as { content: string; sections: { heading: string }[] };
		expect(read.content).toContain("![[escritura-piso.pdf]]");
		expect(read.sections.map((s) => s.heading)).toEqual(["Escritura del piso", "Página 1", "Página 2"]);
		const hits = parse(await client.callTool({ name: "search", arguments: { query: "notario" } })) as { hits: { path: string; section: { heading: string } }[] };
		expect(hits.hits[0]).toMatchObject({ path: "temas/escritura-piso.md", section: { heading: "Página 2" } });
		const attrs = await env.memory.git.out(["show", "HEAD:.gitattributes"]);
		expect(attrs).toContain("*.pdf filter=lfs");
		const pointer = await env.memory.git.out(["show", "HEAD:temas/escritura-piso.pdf"]);
		expect(pointer).toContain("version https://git-lfs.github.com/spec/v1");
		// A page without text is treated as a scan.
		const scan = parse(await client.callTool({ name: "attach", arguments: { path: "temas/escaneo.pdf", base64: makePdf([""]).toString("base64"), description: "Un escaneo", reason: "Escaneo", confirm_new: true } })) as { warnings: { code: string }[] };
		expect(scan.warnings.map((w) => w.code)).toContain("EXTRACTION_EMPTY");
		await client.close();
	});

	it("accepts the Forgejo webhook only with a valid signature", async () => {
		const body = JSON.stringify({ ref: "refs/heads/main" });
		const bad = await fetch(`${priv.url}/hooks/forgejo`, { method: "POST", headers: { "x-forgejo-signature": "00" }, body });
		expect(bad.status).toBe(401);
		const sig = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
		const good = await fetch(`${priv.url}/hooks/forgejo`, { method: "POST", headers: { "x-forgejo-signature": sig, "content-type": "application/json" }, body });
		expect(good.status).toBe(204);
	});
});

describe("public listener and OAuth", () => {
	const verifier = "v".repeat(64);
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const redirectUri = "https://claude.ai/api/mcp/auth_callback";

	async function register(): Promise<string> {
		const r = await fetch(`${pub.url}/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
		});
		expect(r.status).toBe(201);
		return ((await r.json()) as { client_id: string }).client_id;
	}

	async function authorize(clientId: string): Promise<URL> {
		const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" });
		const toForgejo = await fetch(`${pub.url}/authorize?${q}`, { redirect: "manual" });
		expect(toForgejo.status).toBe(302);
		const upstream = new URL(toForgejo.headers.get("location") as string);
		expect(upstream.origin + upstream.pathname).toBe(`${forgejo.url}/login/oauth/authorize`);
		// The browser signs in at Forgejo, which sends it back to our callback.
		const back = await fetch(`${pub.url}/oauth/callback?code=upstream-code&state=${upstream.searchParams.get("state")}`, { redirect: "manual" });
		expect(back.status).toBe(302);
		return new URL(back.headers.get("location") as string);
	}

	async function token(body: Record<string, string>): Promise<Response> {
		return fetch(`${pub.url}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
	}

	it("publishes metadata and refuses static tokens", async () => {
		const meta = await fetch(`${pub.url}/.well-known/oauth-authorization-server`);
		expect(((await meta.json()) as { registration_endpoint: string }).registration_endpoint).toBe(`${pub.url}/register`);
		const prm = await fetch(`${pub.url}/.well-known/oauth-protected-resource/mcp`);
		expect(prm.status).toBe(200);
		const r = await fetch(`${pub.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json" }, body: "{}" });
		expect(r.status).toBe(401);
		expect(r.headers.get("www-authenticate")).toContain("resource_metadata");
		expect((await fetch(`${pub.url}/uploads/x`, { method: "PUT", body: "x" })).status).toBe(404);
	});

	it("runs the whole flow: DCR, Forgejo sign-in, PKCE, MCP, refresh rotation and reuse detection", async () => {
		const clientId = await register();
		const back = await authorize(clientId);
		expect(back.searchParams.get("state")).toBe("xyz");
		const code = back.searchParams.get("code") as string;
		expect((await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: "w".repeat(64), redirect_uri: redirectUri })).status).toBe(400);
		const back2 = await authorize(clientId);
		const ok = await token({ grant_type: "authorization_code", client_id: clientId, code: back2.searchParams.get("code") as string, code_verifier: verifier, redirect_uri: redirectUri });
		expect(ok.status).toBe(200);
		const tokens = (await ok.json()) as { access_token: string; refresh_token: string; expires_in: number };
		expect(tokens.expires_in).toBe(3600);

		const client = await mcp(pub.url, tokens.access_token);
		const created = parse(await client.callTool({ name: "create", arguments: { path: "temas/desde-claude.md", content: note("Desde claude.ai", "Prueba"), reason: "Prueba OAuth" } }));
		expect(created.commit).toBeTruthy();
		const hist = parse(await client.callTool({ name: "history", arguments: { name: "desde-claude" } })) as { commits: { author: string; trailers: Record<string, string> }[] };
		expect(hist.commits[0]?.author).toBe("Alex García (Claude)");
		expect(hist.commits[0]?.trailers.Client).toBe(`oauth:${clientId}`);
		await client.close();

		const refreshed = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token });
		expect(refreshed.status).toBe(200);
		const next = (await refreshed.json()) as { access_token: string };
		const reuse = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token });
		expect(reuse.status).toBe(400);
		// Reuse revoked the whole family, including the access token just issued.
		await expect(oauth.verifyAccessToken(next.access_token)).rejects.toThrow();
		// OAuth tokens also work on the private listener.
		const back3 = await authorize(clientId);
		const t3 = (await (await token({ grant_type: "authorization_code", client_id: clientId, code: back3.searchParams.get("code") as string, code_verifier: verifier, redirect_uri: redirectUri })).json()) as { access_token: string };
		const viaPrivate = await mcp(priv.url, t3.access_token);
		expect((await viaPrivate.listTools()).tools.length).toBe(15);
		await viaPrivate.close();
		expect(oauth.revokeClient(clientId)).toBeGreaterThan(0);
		await expect(oauth.verifyAccessToken(t3.access_token)).rejects.toThrow();
	});

	it("denies Forgejo users not in the allowed list", async () => {
		forgejoUser = { login: "intruso", full_name: "Intruso" };
		try {
			const clientId = await register();
			const back = await authorize(clientId);
			expect(back.searchParams.get("error")).toBe("access_denied");
			expect(back.searchParams.get("code")).toBeNull();
		} finally {
			forgejoUser = { login: "alex", full_name: "Alex García" };
		}
	});
});
