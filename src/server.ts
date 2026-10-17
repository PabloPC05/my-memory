import type { Server } from "node:http";
import { join } from "node:path";
import { ForgejoOAuthProvider } from "./auth/oauth.js";
import { TokenStore } from "./auth/tokens.js";
import { buildClientsReport, ClientActivity, type ClientsService } from "./clients.js";
import type { ServerConfig } from "./config.js";
import { privateApp, publicApp } from "./http.js";
import { jsonLogger, type Logger } from "./log.js";
import { MemoryService } from "./memory.js";
import { detectOcr } from "./ocr.js";
import { UploadStore } from "./uploads.js";

export interface RunningServer {
	memory: MemoryService;
	tokens: TokenStore;
	oauth: ForgejoOAuthProvider | null;
	servers: Server[];
	stop: () => Promise<void>;
}

function listen(app: ReturnType<typeof privateApp>, address: string, port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = app.listen(port, address, () => resolve(server));
		server.once("error", reject);
		server.requestTimeout = 0; // uploads have no time limit
		server.headersTimeout = 60_000;
	});
}

export async function startServer(config: ServerConfig, log: Logger = jsonLogger(undefined, config.logLevel)): Promise<RunningServer> {
	const uploads = new UploadStore(join(config.dataDir, "uploads"));
	await uploads.init();
	const ocr = await detectOcr(config.ocr, log);
	const memory = new MemoryService({
		repoDir: join(config.dataDir, "repo"),
		indexPath: join(config.dataDir, "index.sqlite"),
		branch: config.branch,
		remote: config.remote ? { url: config.remote.url, username: config.remote.username, token: config.remote.token ?? undefined } : null,
		authorDomain: config.authorDomain,
		uploads,
		pdftotext: config.pdftotext,
		ocr,
		log,
		fetchIntervalMs: config.fetchIntervalSeconds > 0 ? config.fetchIntervalSeconds * 1000 : undefined,
	});
	await memory.start();
	const tokens = new TokenStore(config.tokensFile);
	const oauth =
		config.oauth && config.publicUrl
			? new ForgejoOAuthProvider(join(config.dataDir, "state.sqlite"), { ...config.oauth, publicUrl: config.publicUrl, log })
			: null;
	const activity = new ClientActivity(join(config.dataDir, "activity.sqlite"));
	const clients: ClientsService = {
		record: (client, tool) => activity.record(client, tool),
		report: () =>
			buildClientsReport({
				git: memory.git,
				repoDir: memory.opts.repoDir,
				staticClients: () => tokens.list(),
				oauthClients: () => oauth?.listClients() ?? [],
				activity: () => activity.all(),
			}),
	};
	const flushActivity = setInterval(() => {
		try {
			activity.flush();
		} catch (error) {
			log("warn", "clients.flush_failed", { error: String(error) });
		}
	}, 60_000);
	flushActivity.unref();
	const servers: Server[] = [];
	if (config.listen.public && oauth && config.publicUrl) {
		servers.push(await listen(publicApp({ memory, oauth, publicUrl: config.publicUrl, log, clients }), config.listen.public.address, config.listen.public.port));
	}
	if (config.listen.private) {
		servers.push(await listen(privateApp({ memory, tokens, oauth, uploads, webhookSecret: config.webhookSecret, log, clients }), config.listen.private.address, config.listen.private.port));
	}
	const sweep = setInterval(() => uploads.sweep().catch(() => undefined), 60 * 60 * 1000);
	sweep.unref();
	log("info", "server.started", {
		public: config.listen.public ? `${config.listen.public.address}:${config.listen.public.port}` : null,
		private: config.listen.private ? `${config.listen.private.address}:${config.listen.private.port}` : null,
		tokens: tokens.count,
		oauth: Boolean(oauth),
	});
	return {
		memory,
		tokens,
		oauth,
		servers,
		stop: async () => {
			clearInterval(sweep);
			clearInterval(flushActivity);
			await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
			await memory.stop();
			oauth?.close();
			activity.close();
		},
	};
}
