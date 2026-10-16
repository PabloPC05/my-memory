import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Level } from "./log.js";

export interface Listen {
	address: string;
	port: number;
}

export interface ServerConfig {
	dataDir: string;
	branch: string;
	authorDomain: string;
	remote: { url: string; username: string; token: string | null } | null;
	listen: { public: Listen | null; private: Listen | null };
	publicUrl: string | null;
	tokensFile: string | null;
	webhookSecret: string | null;
	oauth: {
		forgejoUrl: string;
		forgejoInternalUrl: string;
		clientId: string;
		clientSecret: string;
		allowedUsers: string[];
		accessTtlSeconds: number;
		refreshTtlSeconds: number;
	} | null;
	fetchIntervalSeconds: number;
	pdftotext: string;
	logLevel: Level;
}

/**
 * A path to a secret. `credential:NAME` reads `$CREDENTIALS_DIRECTORY/NAME` (systemd LoadCredential),
 * anything else is a file path relative to the config file.
 */
function secretPath(value: string, base: string): string {
	if (value.startsWith("credential:")) {
		const dir = process.env.CREDENTIALS_DIRECTORY;
		if (!dir) throw new Error(`${value}: CREDENTIALS_DIRECTORY is not set (is this running under systemd with LoadCredential?)`);
		return join(dir, value.slice("credential:".length));
	}
	return isAbsolute(value) ? value : resolve(base, value);
}

function readSecret(value: unknown, key: string, base: string, read = true): string | null {
	if (value === undefined) return null;
	if (typeof value !== "string" || !value) throw new Error(`${key} must be a path`);
	if (!read) return "(not loaded)";
	const text = readFileSync(secretPath(value, base), "utf8").trim();
	if (!text) throw new Error(`${key}: the file is empty`);
	return text;
}

function str(v: unknown, key: string, fallback?: string): string {
	if (v === undefined && fallback !== undefined) return fallback;
	if (typeof v !== "string" || !v) throw new Error(`${key} must be a non-empty string`);
	return v;
}

function listen(v: unknown, key: string): Listen | null {
	if (v === undefined) return null;
	const t = v as Record<string, unknown>;
	if (typeof t.port !== "number" || !Number.isInteger(t.port)) throw new Error(`${key}.port must be an integer`);
	return { address: str(t.address, `${key}.address`, "127.0.0.1"), port: t.port };
}

/** `secrets: false` skips reading secret files: for CLI commands that run outside the service. */
export function loadConfig(file: string, opts: { secrets?: boolean } = {}): ServerConfig {
	const read = opts.secrets ?? true;
	const base = resolve(file, "..");
	const doc = parseToml(readFileSync(file, "utf8")) as Record<string, unknown>;
	const remote = doc.remote as Record<string, unknown> | undefined;
	const oauth = doc.oauth as Record<string, unknown> | undefined;
	const listenT = (doc.listen ?? {}) as Record<string, unknown>;
	const dataDir = resolve(base, str(doc.data_dir, "data_dir", "/var/lib/my-memory"));
	const config: ServerConfig = {
		dataDir,
		branch: str(doc.branch, "branch", "main"),
		authorDomain: str(doc.author_domain, "author_domain", "my-memory.invalid"),
		remote: remote
			? { url: str(remote.url, "remote.url"), username: str(remote.username, "remote.username", "my-memory"), token: readSecret(remote.token_file, "remote.token_file", base, read) }
			: null,
		listen: { public: listen(listenT.public, "listen.public"), private: listen(listenT.private, "listen.private") },
		publicUrl: doc.public_url === undefined ? null : str(doc.public_url, "public_url").replace(/\/+$/, ""),
		tokensFile: doc.tokens_file === undefined ? null : resolve(base, str(doc.tokens_file, "tokens_file")),
		webhookSecret: readSecret(doc.webhook_secret_file, "webhook_secret_file", base, read),
		oauth: oauth
			? {
					forgejoUrl: str(oauth.forgejo_url, "oauth.forgejo_url"),
					forgejoInternalUrl: str(oauth.forgejo_internal_url ?? oauth.forgejo_url, "oauth.forgejo_internal_url"),
					clientId: readSecret(oauth.client_id_file, "oauth.client_id_file", base, read) ?? str(oauth.client_id, "oauth.client_id"),
					clientSecret: readSecret(oauth.client_secret_file, "oauth.client_secret_file", base, read) ?? "",
					allowedUsers: Array.isArray(oauth.allowed_users) ? (oauth.allowed_users as string[]) : [],
					accessTtlSeconds: typeof oauth.access_ttl_seconds === "number" ? oauth.access_ttl_seconds : 3600,
					refreshTtlSeconds: typeof oauth.refresh_ttl_seconds === "number" ? oauth.refresh_ttl_seconds : 30 * 24 * 3600,
				}
			: null,
		fetchIntervalSeconds: typeof doc.fetch_interval_seconds === "number" ? doc.fetch_interval_seconds : 300,
		pdftotext: str(doc.pdftotext, "pdftotext", "pdftotext"),
		logLevel: (["debug", "info", "warn", "error"].includes(doc.log_level as string) ? doc.log_level : "info") as Level,
	};
	if (config.listen.public) {
		if (!config.oauth) throw new Error("listen.public needs [oauth]: only OAuth tokens are accepted on the public listener");
		if (!config.publicUrl) throw new Error("listen.public needs public_url");
		if (!config.oauth.clientSecret) throw new Error("oauth.client_secret_file is required");
		if (config.oauth.allowedUsers.length === 0) throw new Error("oauth.allowed_users must name at least one Forgejo login");
	}
	if (!config.listen.public && !config.listen.private) throw new Error("configure at least one of listen.public or listen.private");
	return config;
}
