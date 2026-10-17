import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ForgejoOAuthProvider } from "./auth/oauth.js";
import { addToken, listTokens, revokeToken } from "./auth/tokens.js";
import { buildClientsReport, ClientActivity, renderClientsTable } from "./clients.js";
import { loadConfig } from "./config.js";
import { Git } from "./git.js";
import { jsonLogger } from "./log.js";
import { MemoryService } from "./memory.js";
import { applyMigration, planMigration, renderPlan } from "./migrate.js";
import { startServer } from "./server.js";

const USAGE = `my-memory — git-backed memory server for AI agents (MCP)

Usage:
  my-memory serve --config <file>
  my-memory token add <id> --name <name> --scope read|write (--config <file> | --file <tokens.toml>)
  my-memory token list   (--config <file> | --file <tokens.toml>)
  my-memory token revoke <id> (--config <file> | --file <tokens.toml>)
  my-memory oauth list --config <file>
  my-memory oauth revoke <client_id|all> --config <file>
  my-memory clients [--json] --config <file>   who is connected: last seen, writes, setup version
  my-memory reindex --config <file>          full rebuild of the index (stop the service first)
  my-memory migrate <repo-dir> [--apply] [--conventions <memory.toml>]

The config file is TOML; see the README for every key.
`;

function tokensFile(values: { config?: string; file?: string }): string {
	if (values.file) return values.file;
	if (!values.config) throw new Error("give --config or --file");
	const config = loadConfig(values.config, { secrets: false });
	if (!config.tokensFile) throw new Error("the config has no tokens_file");
	return config.tokensFile;
}

export async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: "string", short: "c" },
			file: { type: "string" },
			name: { type: "string" },
			scope: { type: "string" },
			apply: { type: "boolean" },
			conventions: { type: "string" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, sub, arg] = positionals;
	try {
		if (values.help || !command) {
			process.stdout.write(USAGE);
			return command ? 0 : 1;
		}
		if (command === "serve") {
			if (!values.config) throw new Error("serve needs --config");
			const config = loadConfig(values.config);
			const running = await startServer(config);
			process.on("SIGHUP", () => {
				try {
					running.tokens.reload();
					jsonLogger()("info", "tokens.reloaded", { count: running.tokens.count });
				} catch (error) {
					jsonLogger()("error", "tokens.reload_failed", { error: (error as Error).message });
				}
			});
			await new Promise<void>((resolve) => {
				const stop = () => resolve();
				process.once("SIGTERM", stop);
				process.once("SIGINT", stop);
			});
			await running.stop();
			return 0;
		}
		if (command === "token") {
			const file = tokensFile(values);
			if (sub === "add") {
				if (!arg) throw new Error("token add needs an id");
				const scope = values.scope ?? "write";
				if (scope !== "read" && scope !== "write") throw new Error("--scope must be read or write");
				const token = await addToken(file, arg, values.name ?? arg, scope);
				process.stdout.write(`${token}\n`);
				process.stderr.write(`Token «${arg}» (${scope}) saved. This is the only time it is shown. Reload the service (SIGHUP) to use it.\n`);
				return 0;
			}
			if (sub === "list") {
				for (const t of await listTokens(file)) process.stdout.write(`${t.id}\t${t.scope}\t${t.name}\n`);
				return 0;
			}
			if (sub === "revoke") {
				if (!arg) throw new Error("token revoke needs an id");
				const done = await revokeToken(file, arg);
				process.stderr.write(done ? `Revoked «${arg}». Reload the service (SIGHUP).\n` : `No token «${arg}».\n`);
				return done ? 0 : 1;
			}
			throw new Error("token: add, list or revoke");
		}
		if (command === "oauth") {
			if (!values.config) throw new Error("oauth needs --config");
			const config = loadConfig(values.config, { secrets: false });
			if (!config.oauth || !config.publicUrl) throw new Error("the config has no [oauth]");
			const provider = new ForgejoOAuthProvider(join(config.dataDir, "state.sqlite"), { ...config.oauth, publicUrl: config.publicUrl });
			try {
				if (sub === "list") {
					for (const c of provider.listClients()) process.stdout.write(`${c.client_id}\t${c.client_name ?? "-"}\t${c.created_at}\tactive=${c.active_sessions}\n`);
					return 0;
				}
				if (sub === "revoke") {
					if (!arg) throw new Error("oauth revoke needs a client id or «all»");
					process.stderr.write(`Revoked ${provider.revokeClient(arg)} session(s).\n`);
					return 0;
				}
				throw new Error("oauth: list or revoke");
			} finally {
				provider.close();
			}
		}
		if (command === "clients") {
			if (!values.config) throw new Error("clients needs --config");
			const config = loadConfig(values.config, { secrets: false });
			const repoDir = join(config.dataDir, "repo");
			const provider = config.oauth && config.publicUrl ? new ForgejoOAuthProvider(join(config.dataDir, "state.sqlite"), { ...config.oauth, publicUrl: config.publicUrl }) : null;
			try {
				const report = await buildClientsReport({
					git: new Git(repoDir),
					repoDir,
					staticClients: () => (config.tokensFile ? listTokens(config.tokensFile) : []),
					oauthClients: () => provider?.listClients() ?? [],
					activity: () => ClientActivity.snapshot(join(config.dataDir, "activity.sqlite")),
				});
				process.stdout.write(`${values.json ? JSON.stringify(report, null, 2) : renderClientsTable(report)}
`);
				return 0;
			} finally {
				provider?.close();
			}
		}
		if (command === "reindex") {
			if (!values.config) throw new Error("reindex needs --config");
			const config = loadConfig(values.config, { secrets: false });
			const memory = new MemoryService({
				repoDir: join(config.dataDir, "repo"),
				indexPath: join(config.dataDir, "index.sqlite"),
				branch: config.branch,
				remote: null,
				log: jsonLogger(),
			});
			await memory.start();
			await memory.rebuildIndex();
			await memory.stop();
			return 0;
		}
		if (command === "migrate") {
			if (!sub) throw new Error("migrate needs the path of a clone of the notes repo");
			const plan = await planMigration(sub);
			process.stdout.write(`${renderPlan(plan)}\n`);
			if (!values.apply) {
				process.stdout.write("\nDry run: nothing was written. Run again with --apply to commit.\n");
				return 0;
			}
			const conventions = values.conventions ? await readFile(values.conventions, "utf8") : null;
			const commit = await applyMigration(sub, plan, { conventions });
			process.stdout.write(`\nCommitted ${commit}. Push it when you have checked it.\n`);
			return 0;
		}
		throw new Error(`unknown command «${command}»`);
	} catch (error) {
		process.stderr.write(`my-memory: ${(error as Error).message}\n`);
		return 1;
	}
}
