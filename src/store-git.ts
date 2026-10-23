import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Git } from "./git.js";
import type { RemoteConfig } from "./memory.js";
import { type Author, type FetchResult, type FileDates, type LogEntry, type NoteStore, type PushResult, parseTrailers } from "./store.js";
import { type FileChange, parseNameStatus } from "./util.js";

export interface GitStoreOptions {
	repoDir: string;
	branch: string;
	remote?: RemoteConfig | null;
	/** Committer of every commit (the author is the client). */
	committer: Author;
}

/** The notes as a git working clone on disk, with an optional remote it pushes to (see NoteStore). */
export class GitStore implements NoteStore {
	readonly git: Git;
	readonly worktree: string;
	readonly hasRemote: boolean;
	private lfs = false;

	constructor(private readonly opts: GitStoreOptions) {
		this.worktree = opts.repoDir;
		this.hasRemote = Boolean(opts.remote);
		this.git = new Git(opts.repoDir, { config: this.authConfig() });
	}

	get supportsAttachments(): boolean {
		return this.lfs;
	}

	private get branch(): string {
		return this.opts.branch;
	}

	private authConfig(): Record<string, string> {
		if (!this.opts.remote?.token) return {};
		const basic = Buffer.from(`${this.opts.remote.username ?? "my-memory"}:${this.opts.remote.token}`).toString("base64");
		return { "http.extraHeader": `Authorization: Basic ${basic}` };
	}

	async init(): Promise<{ dirty: string[] }> {
		const repoDir = this.opts.repoDir;
		await mkdir(dirname(repoDir), { recursive: true });
		if (!existsSync(join(repoDir, ".git"))) {
			if (this.opts.remote) {
				const parent = new Git(dirname(repoDir), { config: this.authConfig() });
				await parent.run(["clone", "-q", "--no-checkout", this.opts.remote.url, repoDir]);
				const branches = await this.git.out(["branch", "-r"]);
				if (branches.includes(`origin/${this.branch}`)) await this.git.run(["checkout", "-q", "-B", this.branch, `origin/${this.branch}`]);
				else await this.git.run(["symbolic-ref", "HEAD", `refs/heads/${this.branch}`]);
			} else {
				await mkdir(repoDir, { recursive: true });
				await this.git.run(["init", "-q", "-b", this.branch]);
			}
		}
		for (const [k, v] of [
			["core.autocrlf", "false"],
			["core.quotepath", "false"],
			["user.name", this.opts.committer.name],
			["user.email", this.opts.committer.email],
			["pull.rebase", "true"],
		] as const) {
			await this.git.run(["config", "--local", k, v]);
		}
		this.lfs = await this.git.lfsAvailable();
		if (this.lfs) await this.git.run(["lfs", "install", "--local", "--skip-smudge"], { allowFail: true });
		if (await this.git.isClean()) return { dirty: [] };
		const dirty = (await this.git.out(["status", "--porcelain", "--untracked-files=all"])).trim().split("\n");
		return { dirty: dirty.map((l) => l.slice(3)) };
	}

	head(): Promise<string | null> {
		return this.git.head();
	}

	hasCommit(rev: string): Promise<boolean> {
		return this.git.exists(rev);
	}

	async listFiles(): Promise<string[]> {
		return (await this.git.out(["ls-files", "-z"])).split("\0").filter(Boolean);
	}

	async commitDates(range: { to: string; from?: string | null; latestOnly?: boolean }, paths?: string[]): Promise<Map<string, FileDates>> {
		const revs = range.latestOnly ? ["-1", range.to] : range.from ? [`${range.from}..${range.to}`] : [range.to];
		const out = await this.git.out(["log", "--no-renames", "--format=%x1e%aI%x1f%an", "--name-only", ...revs, ...(paths ? ["--", ...paths] : [])]);
		const dates = new Map<string, FileDates>();
		for (const block of out.split("\x1e")) {
			if (!block.trim()) continue;
			const [header, ...files] = block.split("\n");
			const [at, by] = (header ?? "").split("\x1f") as [string, string];
			for (const f of files) {
				if (!f) continue;
				const d = dates.get(f);
				if (d) {
					d.createdAt = at;
					d.createdBy = by;
				} else dates.set(f, { updatedAt: at, updatedBy: by, createdAt: at, createdBy: by });
			}
		}
		return dates;
	}

	async changedFiles(from: string, to: string): Promise<{ status: string; path: string }[]> {
		const diff = await this.git.out(["diff", "--no-renames", "--name-status", "-z", from, to]);
		const parts = diff.split("\0").filter(Boolean);
		const changed: { status: string; path: string }[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) changed.push({ status: parts[i] as string, path: parts[i + 1] as string });
		return changed;
	}

	async restore(head: string | null): Promise<void> {
		if (head) await this.git.run(["reset", "-q", "--hard", head]);
		else await this.git.run(["read-tree", "--empty"], { allowFail: true });
		await this.git.run(["clean", "-fdq"]);
	}

	async commit(paths: string[], message: string, author: Author): Promise<string | null> {
		await this.git.run(["add", "-A", "--", ...paths]);
		const staged = await this.git.run(["diff", "--cached", "--quiet"], { allowFail: true });
		if (staged.code === 0) return null;
		await this.git.run(["commit", "-q", "--no-verify", "-F", "-"], { input: message, env: { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email } });
		return this.git.head();
	}

	// ── remote ───────────────────────────────────────────────────────────────

	async fetch(): Promise<FetchResult> {
		const fetched = await this.git.run(["fetch", "-q", "origin", this.branch], { allowFail: true });
		if (fetched.code === 0) return { status: "ok" };
		if (/couldn't find remote ref|could not find remote ref/i.test(fetched.stderr)) return { status: "empty" };
		return { status: "unreachable", error: fetched.stderr.trim().split("\n").pop() ?? "" };
	}

	async remoteHead(): Promise<string | null> {
		const r = (await this.git.run(["rev-parse", "--verify", "-q", `origin/${this.branch}`], { allowFail: true })).stdout.trim();
		return r || null;
	}

	async isAncestor(a: string, b: string): Promise<boolean> {
		return (await this.git.run(["merge-base", "--is-ancestor", a, b], { allowFail: true })).code === 0;
	}

	async moveTo(rev: string, opts: { hard?: boolean } = {}): Promise<void> {
		if (opts.hard) {
			await this.git.run(["reset", "-q", "--hard", rev]);
			await this.git.run(["clean", "-fdq"]);
		} else await this.git.run(["merge", "-q", "--ff-only", rev]);
	}

	async rebase(rev: string): Promise<boolean> {
		const rebased = await this.git.run(["rebase", "-q", rev], { allowFail: true });
		if (rebased.code === 0) return true;
		await this.git.run(["rebase", "--abort"], { allowFail: true });
		return false;
	}

	async commitsBetween(a: string, b: string): Promise<string[]> {
		return (await this.git.out(["log", "--format=%H %s", `${a}..${b}`])).trim().split("\n").filter(Boolean);
	}

	async push(): Promise<PushResult> {
		const r = await this.git.run(["push", "-q", "origin", `HEAD:refs/heads/${this.branch}`], { allowFail: true });
		if (r.code === 0) return { status: "ok" };
		if (/\[rejected\]|non-fast-forward|fetch first|stale info|\[remote rejected\]/.test(r.stderr) && !/remote rejected.*(denied|protected|permission)/i.test(r.stderr)) return { status: "rejected" };
		return { status: "failed", error: r.stderr.trim().split("\n").pop() ?? "" };
	}

	// ── history ──────────────────────────────────────────────────────────────

	async show(rev: string, path: string): Promise<string | null> {
		const shown = await this.git.run(["show", `${rev}:${path}`], { allowFail: true });
		return shown.code === 0 ? shown.stdout : null;
	}

	async fileLog(path: string, limit: number): Promise<LogEntry[]> {
		const out = await this.git.out(["log", "--follow", `-n${limit}`, "--format=%x1e%H%x1f%aI%x1f%an%x1f%ae%x1f%s%x1f%(trailers:only=true,unfold=true)", "--", path]);
		return out
			.split("\x1e")
			.filter((b) => b.trim())
			.map((b) => {
				const [commit, date, author, email, message, trailerText] = b.split("\x1f") as string[];
				return { commit: commit as string, date: date as string, author: author as string, email: email as string, message: message as string, trailers: parseTrailers(trailerText ?? "") };
			});
	}

	async log(opts: { limit: number; skip: number; since?: string | null; folder?: string | null }): Promise<LogEntry[]> {
		const out = await this.git.out([
			"log",
			`-n${opts.limit}`,
			`--skip=${opts.skip}`,
			"-M",
			"--name-status",
			"--format=%x1e%H%x1f%aI%x1f%an%x1f%ae%x1f%s%x1f%(trailers:only=true,unfold=true)%x1f",
			...(opts.since ? [`--since=${opts.since}`] : []),
			...(opts.folder ? ["--full-diff", "--", `${opts.folder}/`] : []),
		]);
		return out
			.split("\x1e")
			.filter((b) => b.trim())
			.map((block) => {
				const [commit, date, author, email, message, trailerText, files] = block.split("\x1f") as string[];
				return {
					commit: commit as string,
					date: date as string,
					author: author as string,
					email: email as string,
					message: message as string,
					trailers: parseTrailers(trailerText ?? ""),
					files: parseNameStatus(files ?? ""),
				};
			});
	}

	// ── revert ───────────────────────────────────────────────────────────────

	async resolveCommit(rev: string): Promise<string | null> {
		if (!(await this.git.exists(rev))) return null;
		return (await this.git.out(["rev-parse", "--verify", `${rev}^{commit}`])).trim();
	}

	async parents(commit: string): Promise<string[]> {
		return (await this.git.out(["rev-list", "--parents", "-n1", commit])).trim().split(" ").slice(1);
	}

	async diff(base: string, target: string): Promise<FileChange[]> {
		return parseNameStatus(await this.git.out(["diff", "-M", "--name-status", base, target]));
	}

	async blobAt(rev: string, path: string): Promise<string | null> {
		const r = await this.git.run(["rev-parse", "-q", "--verify", `${rev}:${path}`], { allowFail: true });
		return r.code === 0 ? r.stdout.trim() : null;
	}

	blobText(id: string): Promise<string> {
		return this.git.out(["cat-file", "blob", id]);
	}

	/** A blob as raw bytes, for files copied from history unchanged (no round trip through UTF-8). */
	blobBytes(id: string): Promise<Buffer> {
		return this.git.bytes(["cat-file", "blob", id]);
	}

	async mergeText(ours: string, base: string, theirs: string): Promise<string | null> {
		const dir = await mkdtemp(join(tmpdir(), "mm-merge-"));
		try {
			const files = ["ours", "base", "theirs"].map((f) => join(dir, f));
			await Promise.all([ours, base, theirs].map((text, i) => writeFile(files[i] as string, text, "utf8")));
			const r = await this.git.run(["merge-file", "-p", "-q", ...files], { allowFail: true });
			return r.code === 0 ? r.stdout : null;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	async commitsTouching(target: string, path: string): Promise<string[]> {
		return (await this.git.out(["log", "--format=%H %s", `${target}..HEAD`, "--", path])).trim().split("\n").filter(Boolean);
	}

	async renamesSince(target: string): Promise<FileChange[]> {
		return parseNameStatus(await this.git.out(["log", "-M", "--diff-filter=R", "--name-status", "--format=", `${target}..HEAD`]));
	}

	async isLfsTracked(path: string): Promise<boolean> {
		const attr = await this.git.out(["check-attr", "filter", "--", path]);
		return /filter: lfs\s*$/.test(attr.trim());
	}
}
