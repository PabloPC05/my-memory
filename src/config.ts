import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { EmbeddingsConfig } from "./embeddings.js";
import type { IngestConfig } from "./ingest.js";
import type { FilesConfig } from "./integrations.js";
import type { Level } from "./log.js";
import { defaultOcrSettings, type OcrSettings } from "./ocr.js";

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
	/** Optional semantic search; null keeps search full-text only. */
	embeddings: (EmbeddingsConfig & { apiKeyFile: string | null }) | null;
	pdftotext: string;
	ocr: OcrSettings;
	logLevel: Level;
	/** The user's Google Drive as files (and the sources folder), or null. */
	files: (FilesConfig & { checkIntervalSeconds: number }) | null;
	/** The agent that ingests the sources folder, or null. */
	ingest: IngestConfig | null;
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

/** Reads a secret named in the config (a path or `credential:NAME`); for the CLI, which loads configs without secrets. */
export function readSecretFile(value: string): string {
	const text = readFileSync(secretPath(value, process.cwd()), "utf8").trim();
	if (!text) throw new Error(`${value}: the file is empty`);
	return text;
}

function num(v: unknown, key: string, fallback: number, min: number): number {
	if (v === undefined) return fallback;
	if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw new Error(`${key} must be a number >= ${min}`);
	return v;
}

function embeddings(t: Record<string, unknown> | undefined, base: string, read: boolean): ServerConfig["embeddings"] {
	if (!t) return null;
	const url = str(t.url, "embeddings.url");
	if (!/^https?:\/\//.test(url)) throw new Error("embeddings.url must be an http(s) URL");
	const keyFile = t.api_key_file === undefined ? null : str(t.api_key_file, "embeddings.api_key_file");
	return {
		url,
		model: str(t.model, "embeddings.model"),
		apiKey: readSecret(t.api_key_file, "embeddings.api_key_file", base, read),
		apiKeyFile: keyFile === null || keyFile.startsWith("credential:") ? keyFile : secretPath(keyFile, base),
		dimensions: t.dimensions === undefined ? null : Math.floor(num(t.dimensions, "embeddings.dimensions", 0, 1)),
		batchSize: Math.floor(num(t.batch_size, "embeddings.batch_size", 32, 1)),
		timeoutSeconds: num(t.timeout_seconds, "embeddings.timeout_seconds", 60, 1),
		queryPrefix: t.query_prefix === undefined ? "" : String(t.query_prefix),
		documentPrefix: t.document_prefix === undefined ? "" : String(t.document_prefix),
	};
}

function files(t: Record<string, unknown> | undefined, base: string, read: boolean, publicUrl: string | null): ServerConfig["files"] {
	if (!t) return null;
	const pushToken = readSecret(t.push_token_file, "drive.push_token_file", base, read);
	if (pushToken && !publicUrl) throw new Error("drive.push_token_file needs public_url: Drive sends its notices to <public_url>/hooks/drive");
	return {
		drive: {
			clientId: str(t.client_id, "drive.client_id"),
			clientSecret: readSecret(t.client_secret_file, "drive.client_secret_file", base, read) ?? str(undefined, "drive.client_secret_file"),
			refreshToken: readSecret(t.refresh_token_file, "drive.refresh_token_file", base, read) ?? str(undefined, "drive.refresh_token_file"),
		},
		sourcesFolder: t.sources_folder === undefined ? null : str(t.sources_folder, "drive.sources_folder"),
		snapshot: t.snapshot === undefined ? true : Boolean(t.snapshot),
		push: pushToken && publicUrl ? { address: `${publicUrl}/hooks/drive`, token: pushToken } : null,
		checkIntervalSeconds: Math.floor(num(t.check_interval_seconds, "drive.check_interval_seconds", 60, 10)),
	};
}

function ingest(t: Record<string, unknown> | undefined, base: string, read: boolean): IngestConfig | null {
	if (!t) return null;
	const provider = str(t.provider, "ingest.provider");
	if (provider !== "anthropic" && provider !== "openai" && provider !== "webhook") throw new Error("ingest.provider must be anthropic, openai or webhook");
	const opt = (v: unknown, key: string) => (v === undefined ? undefined : str(v, key));
	return {
		provider,
		model: opt(t.model, "ingest.model"),
		apiKey: readSecret(t.api_key_file, "ingest.api_key_file", base, read) ?? undefined,
		baseUrl: opt(t.base_url, "ingest.base_url"),
		webhookUrl: opt(t.webhook_url, "ingest.webhook_url"),
		webhookSecret: readSecret(t.webhook_secret_file, "ingest.webhook_secret_file", base, read) ?? undefined,
		maxFilesPerRun: t.max_files_per_run === undefined ? undefined : positiveInt(t.max_files_per_run, "ingest.max_files_per_run", 3),
		maxSteps: t.max_steps === undefined ? undefined : positiveInt(t.max_steps, "ingest.max_steps", 30),
		maxChars: t.max_chars === undefined ? undefined : positiveInt(t.max_chars, "ingest.max_chars", 200_000),
	};
}

function str(v: unknown, key: string, fallback?: string): string {
	if (v === undefined && fallback !== undefined) return fallback;
	if (typeof v !== "string" || !v) throw new Error(`${key} must be a non-empty string`);
	return v;
}

function positiveInt(v: unknown, key: string, fallback: number): number {
	if (v === undefined) return fallback;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${key} must be a positive integer`);
	return v;
}

function ocrSettings(v: unknown): OcrSettings {
	if (v === undefined) return { ...defaultOcrSettings };
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("[ocr] must be a table");
	const t = v as Record<string, unknown>;
	if (t.enabled !== undefined && typeof t.enabled !== "boolean") throw new Error("ocr.enabled must be true or false");
	const languages = str(t.languages, "ocr.languages", defaultOcrSettings.languages);
	if (!/^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/.test(languages)) throw new Error("ocr.languages must be tesseract language codes joined with +, e.g. \"spa+eng\"");
	return {
		enabled: t.enabled ?? defaultOcrSettings.enabled,
		languages,
		maxPages: positiveInt(t.max_pages, "ocr.max_pages", defaultOcrSettings.maxPages),
		pageTimeoutSeconds: positiveInt(t.page_timeout_seconds, "ocr.page_timeout_seconds", defaultOcrSettings.pageTimeoutSeconds),
		dpi: positiveInt(t.dpi, "ocr.dpi", defaultOcrSettings.dpi),
		tesseract: str(t.tesseract, "ocr.tesseract", defaultOcrSettings.tesseract),
		pdftoppm: str(t.pdftoppm, "ocr.pdftoppm", defaultOcrSettings.pdftoppm),
	};
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
		embeddings: embeddings(doc.embeddings as Record<string, unknown> | undefined, base, read),
		pdftotext: str(doc.pdftotext, "pdftotext", "pdftotext"),
		ocr: ocrSettings(doc.ocr),
		logLevel: (["debug", "info", "warn", "error"].includes(doc.log_level as string) ? doc.log_level : "info") as Level,
		files: null,
		ingest: ingest(doc.ingest as Record<string, unknown> | undefined, base, read),
	};
	config.files = files(doc.drive as Record<string, unknown> | undefined, base, read, config.publicUrl);
	if (config.ingest && !config.files?.sourcesFolder) throw new Error("[ingest] needs [drive] with sources_folder");
	if (config.listen.public) {
		if (!config.oauth) throw new Error("listen.public needs [oauth]: only OAuth tokens are accepted on the public listener");
		if (!config.publicUrl) throw new Error("listen.public needs public_url");
		if (!config.oauth.clientSecret) throw new Error("oauth.client_secret_file is required");
		if (config.oauth.allowedUsers.length === 0) throw new Error("oauth.allowed_users must name at least one Forgejo login");
	}
	if (!config.listen.public && !config.listen.private) throw new Error("configure at least one of listen.public or listen.private");
	return config;
}
