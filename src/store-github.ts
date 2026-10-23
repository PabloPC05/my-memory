import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { diff3Merge } from "node-diff3";
import { GitHubClient, GitHubError, type GitHubRepoConfig } from "./github.js";
import { type Logger, silentLogger } from "./log.js";
import { type Author, EMPTY_TREE, type FetchResult, type FileDates, type LogEntry, type NoteStore, type PushResult, parseTrailers, StoreConflictError } from "./store.js";
import { readTarGz } from "./tar.js";
import type { FileChange } from "./util.js";

export interface GitHubStoreOptions extends GitHubRepoConfig {
	/** A local folder for the files of HEAD (a temporary one on a serverless host: /tmp). Emptied at start. */
	worktree: string;
	log?: Logger;
}

interface ApiFile {
	filename: string;
	status: string;
	previous_filename?: string;
}
/** A commit from the REST commits API (`files` only when fetched one by one). */
interface ApiCommit {
	sha: string;
	parents: { sha: string }[];
	commit: { message: string; author: { name: string; email: string; date: string } };
	files?: ApiFile[];
}
/** A commit from the git data API. */
interface GitCommit {
	sha: string;
	tree: { sha: string };
	parents: { sha: string }[];
	message: string;
}
interface Change {
	status: "A" | "M" | "D";
	path: string;
	blob: string | null;
}

const STATUS: Record<string, string> = { added: "A", removed: "D", modified: "M", changed: "M", renamed: "R", copied: "C" };
const subject = (message: string) => message.split("\n")[0] ?? "";

/** Trailers of a commit message: the `Key: value` lines of its last paragraph, as git's %(trailers) reads them. */
function trailersOf(message: string): Record<string, string> {
	const paragraphs = message.trim().split(/\n\s*\n/);
	if (paragraphs.length < 2) return {};
	const last = (paragraphs[paragraphs.length - 1] ?? "").split("\n");
	return last.every((l) => /^[\w-]+:\s/.test(l.trim())) ? parseTrailers(last.join("\n")) : {};
}

function fileChanges(files: ApiFile[] | undefined): FileChange[] {
	return (files ?? []).map((f) => {
		const s = STATUS[f.status] ?? "M";
		return (s === "R" || s === "C") && f.previous_filename ? { status: s, path: f.filename, from: f.previous_filename } : { status: s, path: f.filename };
	});
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i] as T);
			}
		}),
	);
	return out;
}

/**
 * The notes in a GitHub repository, through its API (see NoteStore). Made for serverless hosts: no git binary and no
 * persistent disk. At start it downloads the branch's tarball into `worktree` (a temporary folder); each write is
 * one commit made with the git data API (blobs, a tree on top of HEAD's, the commit) and published by moving the
 * branch without forcing it. If someone else moved the branch in between, their changes come in first; if they
 * touched the same files, the remote wins (StoreConflictError). History tools read the commits API; what never
 * changes (commits, trees, blobs) is cached for the life of the process.
 *
 * Limits: no attachments (git LFS) and no rename following in a note's history.
 */
export class GitHubStore implements NoteStore {
	readonly worktree: string;
	readonly supportsAttachments = false;
	readonly hasRemote = true;
	private readonly gh: GitHubClient;
	private readonly logger: Logger;
	private headSha: string | null = null;
	private headTree: string | null = null;
	private remoteSha: string | null = null;
	/** The files of HEAD, to know what a write changed and to undo a failed one. */
	private pristine = new Map<string, Buffer>();
	private readonly commits = new Map<string, GitCommit>();
	private readonly details = new Map<string, ApiCommit>();
	private readonly trees = new Map<string, Map<string, string>>();
	private readonly blobs = new Map<string, Buffer>();

	constructor(private readonly opts: GitHubStoreOptions) {
		this.worktree = opts.worktree;
		this.gh = new GitHubClient(opts);
		this.logger = opts.log ?? silentLogger;
	}

	private get branch(): string {
		return this.opts.branch;
	}

	private abs(path: string): string {
		return join(this.worktree, ...path.split("/"));
	}

	private repo(path: string): string {
		return this.gh.repoPath(path);
	}

	private encodePath(path: string): string {
		return path.split("/").map(encodeURIComponent).join("/");
	}

	/** `HEAD` means the commit the worktree is at; anything else goes to GitHub as it is. */
	private rev(rev: string): string {
		return rev === "HEAD" && this.headSha ? this.headSha : rev;
	}

	// ── snapshot ─────────────────────────────────────────────────────────────

	private async writeWork(path: string, data: Buffer): Promise<void> {
		await mkdir(dirname(this.abs(path)), { recursive: true });
		await writeFile(this.abs(path), data);
	}

	private async fetchRef(): Promise<string | null> {
		const ref = await this.gh.optionalJson<{ object: { sha: string } }>("GET", this.repo(`/git/ref/heads/${this.encodePath(this.branch)}`));
		return ref?.object.sha ?? null;
	}

	private async gitCommit(sha: string): Promise<GitCommit> {
		const known = this.commits.get(sha);
		if (known) return known;
		const c = await this.gh.json<GitCommit>("GET", this.repo(`/git/commits/${sha}`));
		this.commits.set(c.sha, c);
		return c;
	}

	/** path → blob sha of a tree, recursively. */
	private async treeOf(treeSha: string): Promise<Map<string, string>> {
		const known = this.trees.get(treeSha);
		if (known) return known;
		const t = await this.gh.json<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>("GET", this.repo(`/git/trees/${treeSha}`), { query: { recursive: 1 } });
		if (t.truncated) throw new GitHubError(0, "The repository has too many files for GitHub's tree API.");
		const map = new Map(t.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha] as const));
		this.trees.set(treeSha, map);
		return map;
	}

	private async filesAt(commit: string): Promise<Map<string, string>> {
		return this.treeOf((await this.gitCommit(commit)).tree.sha);
	}

	/** Downloads the files of `sha` into the worktree (whatever was there goes). */
	private async loadSnapshot(sha: string): Promise<void> {
		const gz = await this.gh.bytes(this.repo(`/tarball/${sha}`));
		if (!gz) throw new GitHubError(404, `GitHub has no tarball for ${sha}.`);
		const files = readTarGz(gz, 1);
		await rm(this.worktree, { recursive: true, force: true });
		await mkdir(this.worktree, { recursive: true });
		this.pristine = new Map();
		for (const f of files) {
			await this.writeWork(f.path, f.data);
			this.pristine.set(f.path, f.data);
		}
		this.headSha = sha;
		this.headTree = (await this.gitCommit(sha)).tree.sha;
		this.logger("info", "github.snapshot", { commit: sha.slice(0, 12), files: files.length });
	}

	/** What changed between two commits, from their trees. */
	private async treeDiff(from: string, to: string): Promise<Change[]> {
		const [a, b] = await Promise.all([this.filesAt(from), this.filesAt(to)]);
		const changes: Change[] = [];
		for (const [path, blob] of b) {
			const before = a.get(path);
			if (before === undefined) changes.push({ status: "A", path, blob });
			else if (before !== blob) changes.push({ status: "M", path, blob });
		}
		for (const path of a.keys()) if (!b.has(path)) changes.push({ status: "D", path, blob: null });
		return changes.sort((x, y) => x.path.localeCompare(y.path));
	}

	/** Brings the given remote changes into the worktree and moves HEAD to `to`. */
	private async applyChanges(changes: Change[], to: string): Promise<void> {
		const datas = await mapLimit(changes, 8, async (c) => (c.blob ? this.blobBytes(c.blob) : null));
		for (const [i, c] of changes.entries()) {
			const data = datas[i];
			if (c.status === "D" || !data) {
				await unlink(this.abs(c.path)).catch(() => undefined);
				this.pristine.delete(c.path);
			} else {
				await this.writeWork(c.path, data);
				this.pristine.set(c.path, data);
			}
		}
		this.headSha = to;
		this.headTree = (await this.gitCommit(to)).tree.sha;
	}

	// ── NoteStore ────────────────────────────────────────────────────────────

	async init(): Promise<{ dirty: string[] }> {
		await rm(this.worktree, { recursive: true, force: true });
		await mkdir(this.worktree, { recursive: true });
		const sha = await this.fetchRef();
		this.remoteSha = sha;
		if (sha) await this.loadSnapshot(sha);
		return { dirty: [] };
	}

	async head(): Promise<string | null> {
		return this.headSha;
	}

	async hasCommit(rev: string): Promise<boolean> {
		return (await this.resolveCommit(rev)) !== null;
	}

	async listFiles(): Promise<string[]> {
		return [...this.pristine.keys()].sort();
	}

	/**
	 * The newest commit that touched each note, from GraphQL (40 paths per query). Creation dates are left out: they
	 * would need each note's whole history. Dates are informative, so a failure only logs.
	 */
	async commitDates(range: { to: string; from?: string | null; latestOnly?: boolean }, paths?: string[]): Promise<Map<string, FileDates>> {
		const wanted = (paths ?? [...this.pristine.keys()]).filter((p) => p.toLowerCase().endsWith(".md"));
		const out = new Map<string, FileDates>();
		for (let i = 0; i < wanted.length; i += 40) {
			const chunk = wanted.slice(i, i + 40);
			const fields = chunk.map((p, j) => `f${j}: history(first: 1, path: ${JSON.stringify(p)}) { nodes { authoredDate author { name } } }`).join("\n");
			const query = `query($owner: String!, $name: String!, $expr: String!) { repository(owner: $owner, name: $name) { object(expression: $expr) { ... on Commit { ${fields} } } } }`;
			try {
				const data = await this.gh.graphql<{ repository: { object: Record<string, { nodes: { authoredDate: string; author: { name: string } | null }[] }> | null } | null }>(query, {
					owner: this.opts.owner,
					name: this.opts.repo,
					expr: this.rev(range.to),
				});
				const object = data.repository?.object ?? {};
				chunk.forEach((p, j) => {
					const node = object[`f${j}`]?.nodes?.[0];
					if (node) out.set(p, { updatedAt: node.authoredDate, updatedBy: node.author?.name ?? "" });
				});
			} catch (error) {
				this.logger("warn", "github.dates_failed", { error: (error as Error).message });
				break;
			}
		}
		return out;
	}

	async changedFiles(from: string, to: string): Promise<{ status: string; path: string }[]> {
		return (await this.treeDiff(from, to)).map((c) => ({ status: c.status, path: c.path }));
	}

	async restore(head: string | null): Promise<void> {
		if (head !== this.headSha && head) return this.loadSnapshot(head);
		const present: string[] = [];
		const walk = async (rel: string): Promise<void> => {
			for (const e of await readdir(rel ? this.abs(rel) : this.worktree, { withFileTypes: true }).catch(() => [])) {
				const p = rel ? `${rel}/${e.name}` : e.name;
				if (e.isDirectory()) await walk(p);
				else present.push(p);
			}
		};
		await walk("");
		for (const p of present) if (!this.pristine.has(p)) await unlink(this.abs(p)).catch(() => undefined);
		for (const [p, data] of this.pristine) {
			const now = await readFile(this.abs(p)).catch(() => null);
			if (!now || !now.equals(data)) await this.writeWork(p, data);
		}
	}

	/** The given paths whose worktree content differs from HEAD's (null data: deleted). */
	private async pending(paths: string[]): Promise<{ path: string; data: Buffer | null }[]> {
		const out: { path: string; data: Buffer | null }[] = [];
		for (const path of new Set(paths)) {
			const data = await readFile(this.abs(path)).catch(() => null);
			const before = this.pristine.get(path);
			if (data === null && before === undefined) continue;
			if (data !== null && before !== undefined && data.equals(before)) continue;
			out.push({ path, data });
		}
		return out;
	}

	/** Moves the branch to `sha` without forcing it: false when it is no longer at our HEAD. */
	private async moveBranch(sha: string): Promise<boolean> {
		const r = await this.gh.request("PATCH", this.repo(`/git/refs/heads/${this.encodePath(this.branch)}`), { body: { sha, force: false } });
		if (r.ok) return true;
		if (r.status === 422 || r.status === 409) return false;
		throw new GitHubError(r.status, `GitHub refused to move the branch: ${r.status} ${(await r.text()).slice(0, 200)}`);
	}

	async commit(paths: string[], message: string, author: Author): Promise<string | null> {
		if (!this.headSha || !this.headTree) {
			throw new GitHubError(409, `The repository ${this.opts.owner}/${this.opts.repo} has no branch «${this.branch}» yet: create it on GitHub with a first commit (for example a README) and start again.`);
		}
		for (let attempt = 0; attempt < 4; attempt++) {
			const changes = await this.pending(paths);
			if (changes.length === 0) return null;
			const entries = await mapLimit(changes, 6, async (c) => {
				if (c.data === null) return { path: c.path, mode: "100644", type: "blob", sha: null };
				const blob = await this.gh.json<{ sha: string }>("POST", this.repo("/git/blobs"), { body: { content: c.data.toString("base64"), encoding: "base64" } });
				return { path: c.path, mode: "100644", type: "blob", sha: blob.sha };
			});
			const tree = await this.gh.json<{ sha: string }>("POST", this.repo("/git/trees"), { body: { base_tree: this.headTree, tree: entries } });
			const made = await this.gh.json<{ sha: string }>("POST", this.repo("/git/commits"), {
				body: { message, tree: tree.sha, parents: [this.headSha], author: { name: author.name, email: author.email, date: new Date().toISOString() } },
			});
			if (await this.moveBranch(made.sha)) {
				for (const c of changes) {
					if (c.data === null) this.pristine.delete(c.path);
					else this.pristine.set(c.path, c.data);
				}
				this.headSha = made.sha;
				this.headTree = tree.sha;
				this.remoteSha = made.sha;
				return made.sha;
			}
			// Someone moved the branch meanwhile: bring their changes in, unless they touched the same files.
			const remote = await this.fetchRef();
			const lost = [`${made.sha} ${subject(message)}`];
			if (!remote) throw new StoreConflictError(lost);
			this.remoteSha = remote;
			const theirs = await this.treeDiff(this.headSha, remote);
			const mine = new Set(changes.map((c) => c.path));
			if (theirs.some((t) => mine.has(t.path))) throw new StoreConflictError(lost);
			await this.applyChanges(theirs, remote);
			this.logger("info", "github.rebased", { onto: remote.slice(0, 12), files: theirs.length });
		}
		throw new StoreConflictError([`(4 attempts) ${subject(message)}`]);
	}

	// ── remote ───────────────────────────────────────────────────────────────

	async fetch(): Promise<FetchResult> {
		try {
			this.remoteSha = await this.fetchRef();
			return this.remoteSha ? { status: "ok" } : { status: "empty" };
		} catch (error) {
			return { status: "unreachable", error: (error as Error).message };
		}
	}

	async remoteHead(): Promise<string | null> {
		return this.remoteSha;
	}

	async isAncestor(a: string, b: string): Promise<boolean> {
		if (a === b) return true;
		const c = await this.gh.optionalJson<{ status: string }>("GET", this.repo(`/compare/${a}...${b}`), { query: { per_page: 1 } });
		return c?.status === "ahead" || c?.status === "identical";
	}

	async moveTo(rev: string, opts: { hard?: boolean } = {}): Promise<void> {
		if (opts.hard || !this.headSha) return this.loadSnapshot(rev);
		await this.applyChanges(await this.treeDiff(this.headSha, rev), rev);
	}

	/** Every commit here is already published, so there is never anything of ours to rebase: the remote wins. */
	async rebase(): Promise<boolean> {
		return false;
	}

	async commitsBetween(a: string, b: string): Promise<string[]> {
		const c = await this.gh.optionalJson<{ commits: ApiCommit[] }>("GET", this.repo(`/compare/${a}...${b}`));
		return (c?.commits ?? []).map((x) => `${x.sha} ${subject(x.commit.message)}`);
	}

	async push(): Promise<PushResult> {
		return { status: "ok" };
	}

	// ── history ──────────────────────────────────────────────────────────────

	async show(rev: string, path: string): Promise<string | null> {
		const data = await this.gh.bytes(this.repo(`/contents/${this.encodePath(path)}`), { accept: "application/vnd.github.raw", query: { ref: this.rev(rev) } });
		return data === null ? null : data.toString("utf8");
	}

	private entry(c: ApiCommit): LogEntry {
		return {
			commit: c.sha,
			date: c.commit.author.date,
			author: c.commit.author.name,
			email: c.commit.author.email,
			message: subject(c.commit.message),
			trailers: trailersOf(c.commit.message),
		};
	}

	/** One commit with the files it touched (immutable: cached). */
	private async detail(rev: string): Promise<ApiCommit | null> {
		const known = this.details.get(rev);
		if (known) return known;
		const r = await this.gh.request("GET", this.repo(`/commits/${encodeURIComponent(rev)}`));
		if (r.status === 404 || r.status === 422 || r.status === 409) return null;
		if (!r.ok) throw new GitHubError(r.status, `GitHub GET commit: ${r.status}`);
		const c = (await r.json()) as ApiCommit;
		this.details.set(c.sha, c);
		return c;
	}

	async fileLog(path: string, limit: number): Promise<LogEntry[]> {
		const list = await this.gh.json<ApiCommit[]>("GET", this.repo("/commits"), { query: { sha: this.headSha ?? this.branch, path, per_page: Math.min(limit, 100) } });
		return list.slice(0, limit).map((c) => this.entry(c));
	}

	async log(opts: { limit: number; skip: number; since?: string | null; folder?: string | null }): Promise<LogEntry[]> {
		if (!this.headSha) return [];
		const found: ApiCommit[] = [];
		let page = Math.floor(opts.skip / 100) + 1;
		let offset = opts.skip % 100;
		while (found.length < opts.limit) {
			const list = await this.gh.json<ApiCommit[]>("GET", this.repo("/commits"), {
				query: { sha: this.headSha, per_page: 100, page, since: opts.since ?? undefined, path: opts.folder ? `${opts.folder}/` : undefined },
			});
			found.push(...list.slice(offset));
			offset = 0;
			if (list.length < 100) break;
			page++;
		}
		const chosen = found.slice(0, opts.limit);
		const details = await mapLimit(chosen, 8, (c) => this.detail(c.sha));
		return chosen.map((c, i) => ({ ...this.entry(c), files: fileChanges(details[i]?.files) }));
	}

	// ── revert ───────────────────────────────────────────────────────────────

	async resolveCommit(rev: string): Promise<string | null> {
		const r = this.rev(rev);
		if (/^[0-9a-f]{40}$/.test(r) && (this.commits.has(r) || this.details.has(r))) return r;
		return (await this.detail(r))?.sha ?? null;
	}

	async parents(commit: string): Promise<string[]> {
		return (await this.gitCommit(commit)).parents.map((p) => p.sha);
	}

	async diff(base: string, target: string): Promise<FileChange[]> {
		if (base === EMPTY_TREE) return [...(await this.filesAt(target)).keys()].map((path) => ({ status: "A", path }));
		const c = await this.gh.json<{ files?: ApiFile[] }>("GET", this.repo(`/compare/${base}...${target}`));
		return fileChanges(c.files);
	}

	async blobAt(rev: string, path: string): Promise<string | null> {
		return (await this.filesAt(this.rev(rev))).get(path) ?? null;
	}

	async blobText(id: string): Promise<string> {
		return (await this.blobBytes(id)).toString("utf8");
	}

	async blobBytes(id: string): Promise<Buffer> {
		const known = this.blobs.get(id);
		if (known) return known;
		const b = await this.gh.json<{ content: string; encoding: string }>("GET", this.repo(`/git/blobs/${id}`));
		const data = Buffer.from(b.content, b.encoding === "base64" ? "base64" : "utf8");
		this.blobs.set(id, data);
		return data;
	}

	async mergeText(ours: string, base: string, theirs: string): Promise<string | null> {
		const blocks = diff3Merge(ours.split("\n"), base.split("\n"), theirs.split("\n"), { excludeFalseConflicts: true });
		if (blocks.some((b) => "conflict" in b && b.conflict)) return null;
		return blocks.flatMap((b) => ("ok" in b && b.ok ? b.ok : [])).join("\n");
	}

	async commitsTouching(target: string, path: string): Promise<string[]> {
		const out: string[] = [];
		for (let page = 1; page <= 10; page++) {
			const list = await this.gh.json<ApiCommit[]>("GET", this.repo("/commits"), { query: { sha: this.headSha ?? this.branch, path, per_page: 100, page } });
			for (const c of list) {
				if (c.sha === target) return out;
				out.push(`${c.sha} ${subject(c.commit.message)}`);
			}
			if (list.length < 100) break;
		}
		return out;
	}

	async renamesSince(target: string): Promise<FileChange[]> {
		if (!this.headSha || target === this.headSha) return [];
		const c = await this.gh.json<{ files?: ApiFile[] }>("GET", this.repo(`/compare/${target}...${this.headSha}`));
		return fileChanges(c.files).filter((f) => f.status === "R");
	}

	async isLfsTracked(): Promise<boolean> {
		return false;
	}
}
