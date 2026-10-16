import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { type Logger, silentLogger } from "../log.js";
import { sha256 } from "../util.js";

export interface OAuthConfig {
	/** Public base URL of this server, e.g. https://memoria.example.com. */
	publicUrl: string;
	/** Forgejo as the browser sees it (it may be reachable only on the tailnet). */
	forgejoUrl: string;
	/** Forgejo as this server reaches it (usually localhost). */
	forgejoInternalUrl: string;
	clientId: string;
	clientSecret: string;
	/** Forgejo logins allowed to authorize clients. */
	allowedUsers: string[];
	accessTtlSeconds?: number;
	refreshTtlSeconds?: number;
	fetch?: typeof fetch;
	log?: Logger;
}

interface User {
	login: string;
	name: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, info TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending (state TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  resource TEXT, user TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, family TEXT NOT NULL, client_id TEXT NOT NULL,
  user TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tokens_family ON tokens (family);
CREATE TABLE IF NOT EXISTS families (family TEXT PRIMARY KEY, client_id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
`;

type Row = Record<string, unknown>;
const now = () => Math.floor(Date.now() / 1000);
const random = () => randomBytes(32).toString("base64url");
const PENDING_TTL = 10 * 60;
const CODE_TTL = 5 * 60;

/**
 * OAuth 2.1 authorization server for MCP clients such as claude.ai: dynamic client registration and PKCE,
 * handled by the MCP SDK's router; the person signs in with Forgejo, which has no DCR of its own.
 * Codes and tokens are random strings stored only as hashes in state.sqlite.
 */
export class ForgejoOAuthProvider implements OAuthServerProvider {
	readonly db: DatabaseSync;
	private readonly log: Logger;
	private readonly fetchFn: typeof fetch;

	constructor(
		dbPath: string,
		private readonly config: OAuthConfig,
	) {
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
		this.db.exec(SCHEMA);
		this.log = config.log ?? silentLogger;
		this.fetchFn = config.fetch ?? fetch;
	}

	close(): void {
		if (this.db.isOpen) this.db.close();
	}

	get callbackUrl(): string {
		return new URL("/oauth/callback", this.config.publicUrl).toString();
	}

	readonly clientsStore: OAuthRegisteredClientsStore = {
		getClient: (clientId: string) => {
			const r = this.db.prepare("SELECT info FROM clients WHERE client_id = ?").get(clientId) as Row | undefined;
			return r ? (JSON.parse(r.info as string) as OAuthClientInformationFull) : undefined;
		},
		registerClient: (client) => {
			const full = client as OAuthClientInformationFull;
			this.db.prepare("INSERT INTO clients (client_id, info, created_at) VALUES (?, ?, ?)").run(full.client_id, JSON.stringify(full), now());
			this.log("info", "oauth.client_registered", { client_id: full.client_id, client_name: full.client_name ?? null });
			return full;
		},
	};

	async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
		this.db.prepare("DELETE FROM pending WHERE created_at < ?").run(now() - PENDING_TTL);
		const state = random();
		this.db
			.prepare("INSERT INTO pending (state, client_id, params, created_at) VALUES (?, ?, ?, ?)")
			.run(state, client.client_id, JSON.stringify({ ...params, resource: params.resource?.toString() }), now());
		const url = new URL("/login/oauth/authorize", this.config.forgejoUrl);
		url.searchParams.set("client_id", this.config.clientId);
		url.searchParams.set("redirect_uri", this.callbackUrl);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("state", state);
		url.searchParams.set("scope", "read:user");
		res.redirect(302, url.toString());
	}

	/** GET /oauth/callback: Forgejo sends the person back here after signing in. */
	readonly callback = async (req: Request, res: Response): Promise<void> => {
		res.setHeader("Cache-Control", "no-store");
		const state = typeof req.query.state === "string" ? req.query.state : "";
		const pending = this.db.prepare("SELECT * FROM pending WHERE state = ?").get(state) as Row | undefined;
		this.db.prepare("DELETE FROM pending WHERE state = ?").run(state);
		if (!pending || (pending.created_at as number) < now() - PENDING_TTL) {
			res.status(400).type("text/plain").send("This sign-in link has expired. Start the connection again from your client.");
			return;
		}
		const params = JSON.parse(pending.params as string) as { redirectUri: string; state?: string; codeChallenge: string; resource?: string };
		const back = (query: Record<string, string>) => {
			const url = new URL(params.redirectUri);
			for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
			if (params.state) url.searchParams.set("state", params.state);
			res.redirect(302, url.toString());
		};
		const upstreamCode = typeof req.query.code === "string" ? req.query.code : "";
		if (!upstreamCode) return back({ error: "access_denied", error_description: "Sign-in was cancelled." });
		let user: User;
		try {
			user = await this.forgejoUser(upstreamCode);
		} catch (error) {
			this.log("warn", "oauth.upstream_failed", { error: String(error) });
			return back({ error: "server_error", error_description: "Could not sign in with Forgejo." });
		}
		if (!this.config.allowedUsers.some((u) => u.toLowerCase() === user.login.toLowerCase())) {
			this.log("warn", "oauth.user_denied", { login: user.login });
			return back({ error: "access_denied", error_description: "This account may not use this memory." });
		}
		const code = random();
		this.db
			.prepare("INSERT INTO codes (code_hash, client_id, challenge, redirect_uri, resource, user, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(sha256(code), pending.client_id as string, params.codeChallenge, params.redirectUri, params.resource ?? null, JSON.stringify(user), now() + CODE_TTL);
		this.log("info", "oauth.authorized", { client_id: pending.client_id, login: user.login });
		back({ code });
	};

	private async forgejoUser(code: string): Promise<User> {
		const tokenRes = await this.fetchFn(new URL("/login/oauth/access_token", this.config.forgejoInternalUrl), {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
				redirect_uri: this.callbackUrl,
			}),
		});
		if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
		const token = (await tokenRes.json()) as { access_token?: string };
		if (!token.access_token) throw new Error("token exchange returned no access_token");
		const userRes = await this.fetchFn(new URL("/api/v1/user", this.config.forgejoInternalUrl), { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" } });
		if (!userRes.ok) throw new Error(`user lookup failed: ${userRes.status}`);
		const u = (await userRes.json()) as { login?: string; username?: string; full_name?: string };
		const login = u.login ?? u.username;
		if (!login) throw new Error("user lookup returned no login");
		return { login, name: u.full_name?.trim() || login };
	}

	async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
		const r = this.db.prepare("SELECT challenge, client_id, expires_at FROM codes WHERE code_hash = ?").get(sha256(authorizationCode)) as Row | undefined;
		if (!r || r.client_id !== client.client_id || (r.expires_at as number) < now()) throw new InvalidGrantError("Invalid or expired authorization code");
		return r.challenge as string;
	}

	async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
		const hash = sha256(authorizationCode);
		const r = this.db.prepare("SELECT * FROM codes WHERE code_hash = ?").get(hash) as Row | undefined;
		this.db.prepare("DELETE FROM codes WHERE code_hash = ?").run(hash);
		if (!r || r.client_id !== client.client_id || (r.expires_at as number) < now()) throw new InvalidGrantError("Invalid or expired authorization code");
		if (redirectUri && redirectUri !== r.redirect_uri) throw new InvalidGrantError("redirect_uri does not match");
		const family = random();
		this.db.prepare("INSERT INTO families (family, client_id, created_at) VALUES (?, ?, ?)").run(family, client.client_id, now());
		return this.issue(client.client_id, family, JSON.parse(r.user as string) as User, resource?.toString() ?? (r.resource as string | null));
	}

	async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
		const hash = sha256(refreshToken);
		const r = this.db.prepare("SELECT t.*, f.revoked FROM tokens t JOIN families f ON f.family = t.family WHERE t.token_hash = ? AND t.kind = 'refresh'").get(hash) as Row | undefined;
		if (!r || r.client_id !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
		if (r.revoked === 1 || (r.expires_at as number) < now()) throw new InvalidGrantError("Refresh token expired or revoked");
		if (r.used === 1) {
			// A rotated refresh token came back: someone kept a copy. Revoke the whole family.
			this.db.prepare("UPDATE families SET revoked = 1 WHERE family = ?").run(r.family as string);
			this.log("warn", "oauth.refresh_reuse", { client_id: client.client_id });
			throw new InvalidGrantError("Refresh token already used");
		}
		this.db.prepare("UPDATE tokens SET used = 1 WHERE token_hash = ?").run(hash);
		return this.issue(client.client_id, r.family as string, JSON.parse(r.user as string) as User, resource?.toString() ?? (r.resource as string | null));
	}

	private issue(clientId: string, family: string, user: User, resource: string | null): OAuthTokens {
		const access = random();
		const refresh = random();
		const accessTtl = this.config.accessTtlSeconds ?? 3600;
		const refreshTtl = this.config.refreshTtlSeconds ?? 30 * 24 * 3600;
		const insert = this.db.prepare("INSERT INTO tokens (token_hash, kind, family, client_id, user, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, 'write', ?, ?)");
		insert.run(sha256(access), "access", family, clientId, JSON.stringify(user), resource, now() + accessTtl);
		insert.run(sha256(refresh), "refresh", family, clientId, JSON.stringify(user), resource, now() + refreshTtl);
		this.db.prepare("DELETE FROM tokens WHERE expires_at < ?").run(now() - 24 * 3600);
		return { access_token: access, token_type: "Bearer", expires_in: accessTtl, refresh_token: refresh, scope: "write" };
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const r = this.db.prepare("SELECT t.*, f.revoked FROM tokens t JOIN families f ON f.family = t.family WHERE t.token_hash = ? AND t.kind = 'access'").get(sha256(token)) as Row | undefined;
		if (!r || r.revoked === 1 || (r.expires_at as number) < now()) throw new InvalidTokenError("Invalid or expired token");
		const user = JSON.parse(r.user as string) as User;
		const client = this.clientsStore.getClient(r.client_id as string) as OAuthClientInformationFull | undefined;
		return {
			token,
			clientId: r.client_id as string,
			scopes: (r.scopes as string).split(" "),
			expiresAt: r.expires_at as number,
			...(r.resource ? { resource: new URL(r.resource as string) } : {}),
			extra: { via: "oauth", user: user.name, login: user.login, clientName: client?.client_name ?? "OAuth client" },
		};
	}

	async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
		const r = this.db.prepare("SELECT family, client_id FROM tokens WHERE token_hash = ?").get(sha256(request.token)) as Row | undefined;
		if (r && r.client_id === client.client_id) this.db.prepare("UPDATE families SET revoked = 1 WHERE family = ?").run(r.family as string);
	}

	listClients(): { client_id: string; client_name: string | null; created_at: string; active_sessions: number }[] {
		return (this.db.prepare("SELECT c.client_id, c.info, c.created_at, (SELECT count(*) FROM families f WHERE f.client_id = c.client_id AND f.revoked = 0) AS active FROM clients c ORDER BY c.created_at").all() as Row[]).map((r) => ({
			client_id: r.client_id as string,
			client_name: (JSON.parse(r.info as string) as OAuthClientInformationFull).client_name ?? null,
			created_at: new Date((r.created_at as number) * 1000).toISOString(),
			active_sessions: r.active as number,
		}));
	}

	/** Revokes every token of a client, or of all clients. */
	revokeClient(clientId: string | "all"): number {
		const r = clientId === "all" ? this.db.prepare("UPDATE families SET revoked = 1 WHERE revoked = 0").run() : this.db.prepare("UPDATE families SET revoked = 1 WHERE client_id = ? AND revoked = 0").run(clientId);
		return Number(r.changes);
	}
}
