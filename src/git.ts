import { execFile } from "node:child_process";

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface GitOptions {
	/** Extra config passed through GIT_CONFIG_* variables, so secrets never show up in the process arguments. */
	config?: Record<string, string>;
	env?: Record<string, string>;
	gitBinary?: string;
}

export class GitError extends Error {
	constructor(
		readonly args: string[],
		readonly result: GitResult,
	) {
		super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
		this.name = "GitError";
	}
}

/** Thin wrapper over the git binary: no shell, fixed locale, never prompts. */
export class Git {
	constructor(
		readonly cwd: string,
		private readonly options: GitOptions = {},
	) {}

	private env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			LC_ALL: "C",
			LANG: "C",
			GIT_TERMINAL_PROMPT: "0",
			GIT_LFS_SKIP_SMUDGE: "1",
			GIT_EDITOR: "true",
			...this.options.env,
			...extra,
		};
		const config = Object.entries(this.options.config ?? {});
		if (config.length > 0) {
			env.GIT_CONFIG_COUNT = String(config.length);
			config.forEach(([key, value], i) => {
				env[`GIT_CONFIG_KEY_${i}`] = key;
				env[`GIT_CONFIG_VALUE_${i}`] = value;
			});
		}
		return env;
	}

	run(args: string[], opts: { input?: string | Buffer; allowFail?: boolean; env?: Record<string, string> } = {}): Promise<GitResult> {
		return new Promise((resolve, reject) => {
			const child = execFile(
				this.options.gitBinary ?? "git",
				args,
				{ cwd: this.cwd, env: this.env(opts.env), maxBuffer: 256 * 1024 * 1024, encoding: "utf8", windowsHide: true },
				(error, stdout, stderr) => {
					const errCode = (error as { code?: unknown } | null)?.code;
					if (errCode === "ENOENT") return reject(new Error(`git binary not found (${this.options.gitBinary ?? "git"})`));
					const code = error ? (typeof errCode === "number" ? errCode : 1) : 0;
					const result = { stdout, stderr, code };
					if (code !== 0 && !opts.allowFail) return reject(new GitError(args, result));
					resolve(result);
				},
			);
			if (opts.input !== undefined) child.stdin?.end(opts.input);
		});
	}

	async out(args: string[]): Promise<string> {
		return (await this.run(args)).stdout;
	}

	async head(): Promise<string | null> {
		const r = await this.run(["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true });
		return r.code === 0 ? r.stdout.trim() : null;
	}

	async isClean(): Promise<boolean> {
		return (await this.out(["status", "--porcelain", "--untracked-files=all"])).trim() === "";
	}

	async exists(rev: string): Promise<boolean> {
		return (await this.run(["cat-file", "-e", `${rev}^{commit}`], { allowFail: true })).code === 0;
	}

	async lfsAvailable(): Promise<boolean> {
		return (await this.run(["lfs", "version"], { allowFail: true })).code === 0;
	}
}
