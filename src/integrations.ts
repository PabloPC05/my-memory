import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { DriveClient, type DriveConfig } from "./drive.js";
import { DriveFiles } from "./drive-files.js";
import { createIngestAgent, type IngestAgent, type IngestConfig, type IngestReport, Ingester } from "./ingest.js";
import { type Logger, silentLogger } from "./log.js";
import type { ClientIdentity, MemoryService } from "./memory.js";
import { DriveSources } from "./sources.js";
import { safeEqual } from "./util.js";

export interface FilesConfig {
	drive: DriveConfig;
	/** The sources folder (path in My Drive, or its id); null: no ingestion. */
	sourcesFolder: string | null;
	/** Keep the index snapshot in the app's hidden folder (needs the drive.appdata scope). Default true. */
	snapshot?: boolean;
	/** Drive push notices: Drive calls `address` (this server's /hooks/drive, public HTTPS) when something changes. */
	push?: { address: string; token: string } | null;
}

/** A Drive push channel, kept in `.my-memory/drive-watch.json`. */
interface WatchState {
	id: string;
	resourceId: string;
	expiration: string;
	address: string;
}

const WATCH_CLIENT: ClientIdentity = { id: "drive-watch", name: "Drive notices", scope: "write" };
const WEEK_MS = 7 * 24 * 3600 * 1000;
const RENEW_BEFORE_MS = 2 * 24 * 3600 * 1000;

/**
 * The files side of a memory: the user's Drive (indexed for the files_* tools) and, when a sources folder and an
 * agent are configured, the ingestion that keeps the memory up to date with it. What makes it run:
 *
 * - Drive's push notices (`/hooks/drive`), within seconds of a change, on hosts with a public HTTPS address;
 * - a periodic check: a timer on a long-lived server, a cron call (`/cron/ingest`) on a serverless host. The check
 *   also renews the push channel, which Drive lets live for a week at most.
 *
 * Every trigger runs the same idempotent pass (refresh the index, ingest what the state says is pending), so a
 * lost notice only delays a source until the next one.
 */
export class Integrations {
	readonly files: DriveFiles;
	readonly ingester: Ingester | null;
	private timer: NodeJS.Timeout | null = null;
	private started = false;
	private readonly log: Logger;

	constructor(
		private readonly memory: MemoryService,
		private readonly config: FilesConfig,
		ingest: IngestConfig | null,
		opts: { log?: Logger; lease?: boolean; budgetMs?: number; agent?: IngestAgent } = {},
	) {
		this.log = opts.log ?? silentLogger;
		this.files = new DriveFiles(new DriveClient(config.drive), { log: this.log, snapshot: config.snapshot });
		const sources = config.sourcesFolder ? new DriveSources(this.files, config.sourcesFolder) : null;
		const agent = opts.agent ?? (ingest ? createIngestAgent(memory, ingest) : null);
		this.ingester = sources && agent && ingest ? new Ingester(memory, this.files, sources, agent, ingest, { log: this.log, lease: opts.lease, budgetMs: opts.budgetMs }) : null;
	}

	async start(): Promise<void> {
		await this.files.start();
		this.started = true;
		this.log("info", "files.started", { files: this.files.size, ingestion: Boolean(this.ingester) });
	}

	/** On a long-lived server: check every `seconds` (refresh, ingest, renew the push channel). */
	startTimer(seconds: number): void {
		this.timer = setInterval(() => {
			this.check("timer").catch((error) => this.log("warn", "files.check_failed", { error: String(error) }));
		}, seconds * 1000);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
	}

	/** One pass: Drive's changes into the index, then the pending sources into the memory. */
	async pass(trigger: string): Promise<IngestReport | null> {
		if (!this.started) await this.start(); // a start that failed (Drive unreachable) is retried here
		if (!this.ingester) {
			await this.files.refresh();
			return null;
		}
		return this.ingester.run(trigger);
	}

	/** The periodic check: a pass, plus the push channel kept alive. */
	async check(trigger: string): Promise<{ ingest: IngestReport | null; watch: string | null }> {
		const ingest = await this.pass(trigger);
		const watch = this.config.push ? await this.renewWatch().catch((error) => `failed: ${(error as Error).message}`) : null;
		return { ingest, watch };
	}

	/** Opens a new push channel when there is none, it is about to expire, or the address changed. */
	async renewWatch(): Promise<string> {
		const push = this.config.push;
		if (!push) return "off";
		const current = await this.memory.readState<WatchState>("drive-watch");
		if (current && current.address === push.address && Date.parse(current.expiration) - Date.now() > RENEW_BEFORE_MS) return `ok until ${current.expiration}`;
		const token = this.files.changesToken;
		if (!token) throw new Error("the Drive index has not started");
		const r = await this.files.drive.json<{ id: string; resourceId: string; expiration?: string }>("POST", "/drive/v3/changes/watch", {
			query: { pageToken: token, includeRemoved: true, spaces: "drive" },
			body: { id: randomUUID(), type: "web_hook", address: push.address, token: push.token, expiration: Date.now() + WEEK_MS },
		});
		const expiration = new Date(r.expiration ? Number(r.expiration) : Date.now() + WEEK_MS).toISOString();
		await this.memory.saveState(WATCH_CLIENT, "drive-watch", { id: r.id, resourceId: r.resourceId, expiration, address: push.address } satisfies WatchState, "Drive notices: channel renewed");
		if (current) {
			await this.files.drive.request("POST", "/drive/v3/channels/stop", { body: JSON.stringify({ id: current.id, resourceId: current.resourceId }), contentType: "application/json" }).catch(() => undefined);
		}
		this.log("info", "drive.watch_renewed", { expiration });
		return `renewed until ${expiration}`;
	}

	/**
	 * The routes: `/hooks/drive` (Drive's notices, checked by the channel token) and `/cron/ingest` (the periodic
	 * check, with `Authorization: Bearer <cronSecret>`, as Vercel Cron sends it). `background` keeps work going after
	 * the answer (Vercel's waitUntil); without it, the pass runs before answering.
	 */
	routes(opts: { cronSecret?: string | null; background?: (work: Promise<unknown>) => void; more?: () => Promise<unknown> }): express.Router {
		const router = express.Router();
		// When a pass leaves sources for later (a time limit), `more` starts another one (on Vercel, a new invocation).
		const andMore = async (report: IngestReport | null) => {
			if (report && report.remaining > 0 && !report.skipped && opts.more) await opts.more();
		};
		const run = (work: () => Promise<unknown>, what: string) => {
			const p = work().catch((error) => this.log("warn", `${what}.failed`, { error: String(error) }));
			if (opts.background) opts.background(p);
			return p;
		};
		router.post("/hooks/drive", async (req: Request, res: Response) => {
			const push = this.config.push;
			const token = req.header("x-goog-channel-token") ?? "";
			if (!push || !safeEqual(token, push.token)) {
				res.status(push ? 401 : 404).end();
				return;
			}
			const state = req.header("x-goog-resource-state");
			if (state === "sync") {
				res.status(204).end(); // the channel's first message: nothing changed yet
				return;
			}
			const work = run(async () => andMore(await this.pass("drive-push")), "drive.push");
			if (!opts.background) await work;
			res.status(204).end();
		});
		router.get("/cron/ingest", async (req: Request, res: Response) => {
			const m = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
			if (!opts.cronSecret || !m?.[1] || !safeEqual(m[1].trim(), opts.cronSecret)) {
				res.status(opts.cronSecret ? 401 : 404).end();
				return;
			}
			const result = await this.check("cron");
			run(() => andMore(result.ingest), "ingest.more");
			res.json(result);
		});
		return router;
	}
}
