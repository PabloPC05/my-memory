import { createHmac } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ForgejoOAuthProvider } from "./auth/oauth.js";
import type { TokenStore } from "./auth/tokens.js";
import type { Logger } from "./log.js";
import type { ClientIdentity, MemoryService } from "./memory.js";
import { createMcpServer, SERVER_NAME } from "./tools.js";
import type { UploadStore } from "./uploads.js";
import { safeEqual } from "./util.js";

/** Who is calling, from the validated token. Static tokens carry their own name; OAuth ones name the person and the app. */
export function identityFrom(req: Request): ClientIdentity {
	const auth = req.auth as AuthInfo;
	const extra = (auth.extra ?? {}) as Record<string, string>;
	const session = req.header("x-memory-session")?.slice(0, 200) ?? null;
	if (extra.via === "static") return { id: auth.clientId, name: extra.name ?? auth.clientId, scope: auth.scopes.includes("write") ? "write" : "read", session };
	return { id: `oauth:${auth.clientId}`, name: `${extra.user ?? "OAuth user"} (${extra.clientName ?? "OAuth client"})`, scope: auth.scopes.includes("write") ? "write" : "read", session };
}

function mcpHandler(memory: MemoryService, log: Logger) {
	return async (req: Request, res: Response) => {
		if (req.method !== "POST") {
			res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST." }, id: null });
			return;
		}
		const client = identityFrom(req);
		const server = await createMcpServer(memory, client, log);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		res.on("close", () => {
			transport.close().catch(() => undefined);
			server.close().catch(() => undefined);
		});
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
	};
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
	return (req: Request, res: Response, next: NextFunction) => {
		fn(req, res).catch(next);
	};
}

function errorHandler(log: Logger) {
	return (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
		log("error", "http.error", { error: String((error as Error)?.stack ?? error) });
		if (!res.headersSent) res.status(500).json({ error: "internal_error" });
	};
}

/**
 * Public listener (behind the public reverse proxy): OAuth endpoints and MCP with OAuth access tokens only.
 * Static tokens are never accepted here, so a leaked one is useless from the internet.
 */
export function publicApp(opts: { memory: MemoryService; oauth: ForgejoOAuthProvider; publicUrl: string; log: Logger }): express.Express {
	const app = express();
	app.disable("x-powered-by");
	app.set("trust proxy", "loopback");
	const issuer = new URL(opts.publicUrl);
	const resource = new URL("/mcp", issuer);
	const minute = { windowMs: 60_000, standardHeaders: true, legacyHeaders: false };
	app.use(
		mcpAuthRouter({
			provider: opts.oauth,
			issuerUrl: issuer,
			resourceServerUrl: resource,
			scopesSupported: ["write"],
			resourceName: SERVER_NAME,
			authorizationOptions: { rateLimit: { ...minute, max: 30 } },
			tokenOptions: { rateLimit: { ...minute, max: 30 } },
			clientRegistrationOptions: { rateLimit: { ...minute, max: 10 } },
		}),
	);
	app.get("/oauth/callback", asyncRoute(opts.oauth.callback));
	app.all("/mcp", requireBearerAuth({ verifier: opts.oauth, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) }), express.json({ limit: "64mb" }), asyncRoute(mcpHandler(opts.memory, opts.log)));
	app.use((_req, res) => {
		res.status(404).json({ error: "not_found" });
	});
	app.use(errorHandler(opts.log));
	return app;
}

/**
 * Private listener (tailnet only): MCP with static tokens (or OAuth ones), uploads and the Forgejo webhook.
 */
export function privateApp(opts: { memory: MemoryService; tokens: TokenStore; oauth?: ForgejoOAuthProvider | null; uploads: UploadStore; webhookSecret?: string | null; log: Logger }): express.Express {
	const app = express();
	app.disable("x-powered-by");

	const authenticate = async (req: Request, res: Response): Promise<boolean> => {
		const m = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
		if (m?.[1]) {
			const token = m[1].trim();
			const stat = opts.tokens.verify(token);
			if (stat) {
				req.auth = { token, clientId: stat.id, scopes: [stat.scope], extra: { via: "static", name: stat.name } };
				return true;
			}
			if (opts.oauth) {
				try {
					req.auth = await opts.oauth.verifyAccessToken(token);
					return true;
				} catch {
					// fall through to 401
				}
			}
		}
		opts.log("warn", "auth.rejected", { listener: "private", path: req.path });
		res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "invalid_token" });
		return false;
	};
	const authenticated = (req: Request, res: Response, next: NextFunction) => {
		authenticate(req, res).then((ok) => ok && next(), next);
	};

	app.post("/hooks/forgejo", express.raw({ type: "*/*", limit: "10mb" }), (req, res) => {
		if (!opts.webhookSecret) {
			res.status(404).end();
			return;
		}
		const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
		const given = (req.header("x-forgejo-signature") ?? req.header("x-gitea-signature") ?? "").trim().toLowerCase();
		const expected = createHmac("sha256", opts.webhookSecret).update(body).digest("hex");
		if (!given || !safeEqual(given, expected)) {
			opts.log("warn", "webhook.bad_signature", {});
			res.status(401).end();
			return;
		}
		opts.memory.requestSync("webhook");
		res.status(204).end();
	});

	app.put(
		"/uploads/:filename",
		authenticated,
		asyncRoute(async (req, res) => {
			const client = identityFrom(req);
			if (client.scope !== "write") {
				res.status(403).json({ error: "forbidden", message: "This client has read-only access." });
				return;
			}
			const filename = String(req.params.filename ?? "");
			if (!/^[^/\\\0]{1,255}$/.test(filename) || filename.startsWith(".")) {
				res.status(400).json({ error: "invalid_filename" });
				return;
			}
			const declared = req.header("content-length") ? Number(req.header("content-length")) : null;
			if (!(await opts.uploads.hasRoomFor(declared))) {
				res.status(507).json({ error: "insufficient_storage" });
				return;
			}
			const started = Date.now();
			const meta = await opts.uploads.receive(req, filename, client.id);
			opts.log("info", "upload", { client: client.id, size: meta.size, ms: Date.now() - started });
			res.status(201).json({ upload_id: meta.id, size: meta.size, sha256: meta.sha256 });
		}),
	);

	app.all("/mcp", authenticated, express.json({ limit: "512mb" }), asyncRoute(mcpHandler(opts.memory, opts.log)));
	app.use((_req, res) => {
		res.status(404).json({ error: "not_found" });
	});
	app.use(errorHandler(opts.log));
	return app;
}
