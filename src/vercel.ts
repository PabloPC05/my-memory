import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { waitUntil } from "@vercel/functions";
import type { NextFunction, Request, Response } from "express";
import { parseTokenList, TokenStore } from "./auth/tokens.js";
import type { EmbeddingsConfig } from "./embeddings.js";
import { privateApp } from "./http.js";
import type { IngestConfig } from "./ingest.js";
import { type FilesConfig, Integrations } from "./integrations.js";
import { jsonLogger, type Level, type Logger } from "./log.js";
import { MemoryService } from "./memory.js";
import { GitHubStore } from "./store-github.js";
import { UploadStore } from "./uploads.js";

type Env = Record<string, string | undefined>;

/** Everything a serverless deployment needs, from environment variables (see docs/deploy-vercel.md). */
export interface ServerlessConfig {
	github: { owner: string; repo: string; branch: string; token: string; apiUrl?: string };
	tokens: string;
	publicUrl: string | null;
	cronSecret: string | null;
	files: FilesConfig | null;
	ingest: IngestConfig | null;
	embeddings: EmbeddingsConfig | null;
	authorDomain: string;
	/** Where the notes, the index and uploads go: the only writable folder on Vercel is /tmp. */
	dataDir: string;
	/** A request syncs with GitHub first when the last sync is older than this. */
	syncEveryMs: number;
	/** How long one ingestion pass may start new sources (the function's limit, minus a margin). */
	ingestBudgetMs: number;
	logLevel: Level;
}

function need(env: Env, key: string): string {
	const v = env[key]?.trim();
	if (!v) throw new Error(`${key} is required`);
	return v;
}

const opt = (env: Env, key: string) => env[key]?.trim() || undefined;
const int = (env: Env, key: string, fallback: number) => {
	const v = opt(env, key);
	if (v === undefined) return fallback;
	const n = Number(v);
	if (!Number.isInteger(n) || n < 1) throw new Error(`${key} must be a positive integer`);
	return n;
};

export function configFromEnv(env: Env = process.env): ServerlessConfig {
	const [owner, repo, ...rest] = need(env, "GITHUB_REPO").split("/");
	if (!owner || !repo || rest.length) throw new Error("GITHUB_REPO must be owner/repo");
	const production = opt(env, "VERCEL_PROJECT_PRODUCTION_URL");
	const publicUrl = (opt(env, "PUBLIC_URL") ?? (production ? `https://${production}` : null))?.replace(/\/+$/, "") ?? null;
	const google = opt(env, "GOOGLE_REFRESH_TOKEN");
	const pushToken = opt(env, "DRIVE_PUSH_TOKEN");
	const files: FilesConfig | null = google
		? {
				drive: { clientId: need(env, "GOOGLE_CLIENT_ID"), clientSecret: need(env, "GOOGLE_CLIENT_SECRET"), refreshToken: google },
				sourcesFolder: opt(env, "DRIVE_SOURCES_FOLDER") ?? null,
				snapshot: opt(env, "DRIVE_SNAPSHOT") !== "false",
				push: pushToken && publicUrl ? { address: `${publicUrl}/hooks/drive`, token: pushToken } : null,
			}
		: null;
	const provider = opt(env, "INGEST_PROVIDER");
	if (provider && provider !== "anthropic" && provider !== "openai" && provider !== "webhook") throw new Error("INGEST_PROVIDER must be anthropic, openai or webhook");
	if (provider && !files?.sourcesFolder) throw new Error("INGEST_PROVIDER needs GOOGLE_* and DRIVE_SOURCES_FOLDER");
	const ingest: IngestConfig | null = provider
		? {
				provider: provider as IngestConfig["provider"],
				model: opt(env, "INGEST_MODEL"),
				apiKey: opt(env, "INGEST_API_KEY") ?? (provider === "anthropic" ? opt(env, "ANTHROPIC_API_KEY") : undefined),
				baseUrl: opt(env, "INGEST_BASE_URL"),
				webhookUrl: opt(env, "INGEST_WEBHOOK_URL"),
				webhookSecret: opt(env, "INGEST_WEBHOOK_SECRET"),
				maxFilesPerRun: int(env, "INGEST_MAX_FILES", 10),
				maxSteps: int(env, "INGEST_MAX_STEPS", 30),
				...(opt(env, "INGEST_THINKING") ? { thinking: opt(env, "INGEST_THINKING") === "true" } : {}),
			}
		: null;
	const tokens = need(env, "MEMORY_TOKENS");
	parseTokenList(tokens); // fail at start, not on the first request
	const embeddingsUrl = opt(env, "EMBEDDINGS_URL");
	const maxDuration = int(env, "FUNCTION_MAX_DURATION", 300);
	return {
		github: { owner, repo, branch: opt(env, "GITHUB_BRANCH") ?? "main", token: need(env, "GITHUB_TOKEN"), apiUrl: opt(env, "GITHUB_API_URL") },
		tokens,
		publicUrl,
		cronSecret: opt(env, "CRON_SECRET") ?? null,
		files,
		ingest,
		embeddings: embeddingsUrl
			? {
					url: embeddingsUrl,
					model: need(env, "EMBEDDINGS_MODEL"),
					apiKey: opt(env, "EMBEDDINGS_API_KEY") ?? null,
					dimensions: opt(env, "EMBEDDINGS_DIMENSIONS") ? int(env, "EMBEDDINGS_DIMENSIONS", 1) : null,
					batchSize: int(env, "EMBEDDINGS_BATCH_SIZE", 32),
					timeoutSeconds: 60,
					queryPrefix: env.EMBEDDINGS_QUERY_PREFIX ?? "",
					documentPrefix: env.EMBEDDINGS_DOCUMENT_PREFIX ?? "",
				}
			: null,
		authorDomain: opt(env, "AUTHOR_DOMAIN") ?? "my-memory.invalid",
		dataDir: opt(env, "DATA_DIR") ?? "/tmp/my-memory",
		syncEveryMs: int(env, "SYNC_EVERY_MS", 5000),
		ingestBudgetMs: Math.max(maxDuration - 120, 30) * 1000,
		logLevel: (["debug", "info", "warn", "error"].includes(env.LOG_LEVEL ?? "") ? env.LOG_LEVEL : "info") as Level,
	};
}

export interface ServerlessApp {
	handle: (req: IncomingMessage, res: ServerResponse) => void;
	memory: MemoryService;
	integrations: Integrations | null;
}

/**
 * The whole server for a serverless host: notes in a GitHub repository (through its API, no git binary), the
 * index rebuilt in /tmp on a cold start, the user's Drive as files, and the routes of the private listener plus
 * Drive's notices and the cron call. Each request first catches up with GitHub when the last sync is a few seconds
 * old, so copies running side by side see each other's writes.
 */
export async function createServerlessApp(config: ServerlessConfig, opts: { log?: Logger; background?: (work: Promise<unknown>) => void } = {}): Promise<ServerlessApp> {
	const log = opts.log ?? jsonLogger(undefined, config.logLevel);
	const uploads = new UploadStore(join(config.dataDir, "uploads"));
	await uploads.init();
	const store = new GitHubStore({ ...config.github, worktree: join(config.dataDir, "notes"), log });
	const memory = new MemoryService({
		repoDir: join(config.dataDir, "notes"),
		indexPath: join(config.dataDir, "index.sqlite"),
		branch: config.github.branch,
		store,
		authorDomain: config.authorDomain,
		uploads,
		log,
		embeddings: config.embeddings,
	});
	await memory.start();
	let integrations: Integrations | null = null;
	if (config.files) {
		integrations = new Integrations(memory, config.files, config.ingest, { log, lease: true, budgetMs: config.ingestBudgetMs });
		memory.files = integrations.files;
		await integrations.start().catch((error) => log("error", "files.start_failed", { error: String(error) }));
	}
	const tokens = new TokenStore(null, parseTokenList(config.tokens));
	const background = opts.background ?? ((work: Promise<unknown>) => void work);
	const more =
		config.publicUrl && config.cronSecret
			? async () => {
					// A new invocation, with its own time limit, for the sources this one had no time for.
					const url = `${config.publicUrl}/cron/ingest`;
					await fetch(url, { headers: { authorization: `Bearer ${config.cronSecret}` }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
				}
			: undefined;
	const routes = integrations?.routes({ cronSecret: config.cronSecret, background, more }) ?? null;
	const app = privateApp({ memory, tokens, uploads, log, routes });
	let lastSync = Date.now();
	const handle = (req: IncomingMessage, res: ServerResponse) => {
		// claude.ai's custom connectors take a URL and no header: /t/<token>/mcp carries the token in the path.
		const m = /^\/t\/([^/?]+)(\/mcp(?:[?#].*)?)$/.exec(req.url ?? "");
		if (m?.[1] && m[2]) {
			req.headers.authorization = `Bearer ${decodeURIComponent(m[1])}`;
			req.url = m[2];
		}
		const go = () => app(req as Request, res as Response, ((error?: unknown) => error && log("error", "http.error", { error: String(error) })) as NextFunction);
		if (Date.now() - lastSync < config.syncEveryMs || req.url?.startsWith("/hooks/")) return go();
		lastSync = Date.now();
		memory.sync("request").then(go, (error) => {
			log("warn", "sync.failed", { error: String(error) });
			go();
		});
	};
	return { handle, memory, integrations };
}

let instance: Promise<ServerlessApp> | null = null;

/** The Vercel function: one app per instance, built on the first request (the cold start). */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
	// configFromEnv inside the promise: a bad configuration answers with its reason instead of crashing the function.
	instance ??= Promise.resolve().then(() => createServerlessApp(configFromEnv(), { background: waitUntil })).catch((error) => {
		instance = null;
		throw error;
	});
	instance.then(
		(a) => a.handle(req, res),
		(error) => {
			process.stdout.write(`${JSON.stringify({ level: "error", event: "startup_failed", error: String(error) })}\n`);
			res.statusCode = 500;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ error: "startup_failed", message: (error as Error).message }));
		},
	);
}
