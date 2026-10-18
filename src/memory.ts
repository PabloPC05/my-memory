import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { CONVENTIONS_FILE, type Conventions, defaultConventions, parseConventions } from "./conventions.js";
import { dot, EmbeddingClient, Embedder, type EmbeddingsConfig, reciprocalRankFusion } from "./embeddings.js";
import { MemoryError } from "./errors.js";
import { extractAttachment, type Extraction } from "./extract.js";
import { parseNote, splitFrontmatter } from "./frontmatter.js";
import { Git } from "./git.js";
import { type LintArgs, lint } from "./lint.js";
import { type Logger, silentLogger } from "./log.js";
import { firstH1, rewriteWikiLinks, splitSections, targetNameOf } from "./markdown.js";
import type { OcrRunner } from "./ocr.js";
import { parseTypedLinks } from "./relations.js";
import { SETUP_GUIDE_URI, SETUP_GUIDE_URL } from "./setup-guide.js";
import { buildFtsQuery, type NoteRow, type SearchHit, SearchIndex } from "./search-index.js";
import type { UploadStore } from "./uploads.js";
import {
	blobHash,
	checkNewFilename,
	checkPath,
	dirOf,
	type FileChange,
	joinPath,
	levenshtein,
	lookAlikeLabels,
	looksLikeSame,
	Mutex,
	normalizeWords,
	noteLabels,
	noteName,
	parseNameStatus,
	parseSince,
	sha256,
	topFolder,
} from "./util.js";

export interface ClientIdentity {
	/** Stable id: the token id, or `oauth:<client_id>`. Goes into the `Client:` trailer. */
	id: string;
	/** Commit author name. */
	name: string;
	scope: "read" | "write";
	session?: string | null;
}

export interface RemoteConfig {
	url: string;
	/** HTTP basic credentials for the remote (a Forgejo bot user and its token). */
	username?: string;
	token?: string;
}

export interface MemoryOptions {
	repoDir: string;
	indexPath: string;
	branch?: string;
	remote?: RemoteConfig | null;
	/** Domain of the author emails: `<client-id>@<domain>`. */
	authorDomain?: string;
	committer?: { name: string; email: string };
	uploads?: UploadStore | null;
	pdftotext?: string;
	/** OCR for scanned PDFs and images; null or absent means no OCR. */
	ocr?: OcrRunner | null;
	log?: Logger;
	pushRetry?: { initialMs: number; maxMs: number };
	fetchIntervalMs?: number;
	/** Optional semantic search through an embeddings endpoint; without it search is full-text only. */
	embeddings?: EmbeddingsConfig | null;
	embeddingsRetry?: { initialMs: number; maxMs: number };
}

export type SearchMode = "hybrid" | "text" | "semantic";

type SearchArgs = { query: string; folder?: string; include_archive?: boolean; limit?: number };

export interface Warning {
	code: "BROKEN_LINKS" | "UNKNOWN_RELATIONS" | "PUSH_PENDING" | "EXTRACTION_EMPTY" | "EXTRACTION_PARTIAL" | "NO_CHANGES" | "FRONTMATTER_PROBLEMS";
	message: string;
	[key: string]: unknown;
}

export interface WriteResult {
	commit: string | null;
	path: string;
	hash: string | null;
	warnings: Warning[];
	[key: string]: unknown;
}

type NoteRef = { path?: string; name?: string };

const READ_ONLY = new MemoryError("FORBIDDEN", "This client has read-only access.");

/** git's empty tree: the "parent" of a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** One commit as `recent` returns it. */
export interface RecentCommit {
	commit: string;
	date: string;
	author: string;
	client: string | null;
	tool: string | null;
	session?: string;
	reverts?: string;
	reason: string;
	notes: { path: string; name?: string; change: "added" | "modified" | "deleted" | "moved" | "copied"; from?: string }[];
}

const CHANGE_NAMES: Record<string, RecentCommit["notes"][number]["change"]> = { A: "added", M: "modified", T: "modified", D: "deleted", R: "moved", C: "copied" };

/**
 * The memory: a git working clone of the notes repo plus its derived index.
 * Reads go straight to the files and the index; every write goes through one queue and ends as one commit.
 */
export class MemoryService {
	readonly git: Git;
	index!: SearchIndex;
	conventions: Conventions = defaultConventions();
	private conventionsHash = "";
	private readonly lock = new Mutex();
	private readonly log: Logger;
	private readonly branch: string;
	private lfs = false;
	private pushPending = false;
	private pushTimer: NodeJS.Timeout | null = null;
	private pushDelay: number;
	private fetchTimer: NodeJS.Timeout | null = null;
	private syncTimer: NodeJS.Timeout | null = null;
	private syncRequested = false;
	/** Background embedding of sections; null when `[embeddings]` is not configured. */
	readonly embedder: Embedder | null = null;

	constructor(readonly opts: MemoryOptions) {
		this.log = opts.log ?? silentLogger;
		this.branch = opts.branch ?? "main";
		this.pushDelay = opts.pushRetry?.initialMs ?? 30_000;
		const config: Record<string, string> = {};
		if (opts.remote?.token) {
			const basic = Buffer.from(`${opts.remote.username ?? "my-memory"}:${opts.remote.token}`).toString("base64");
			config["http.extraHeader"] = `Authorization: Basic ${basic}`;
		}
		this.git = new Git(opts.repoDir, { config });
		if (opts.embeddings) this.embedder = new Embedder(new EmbeddingClient(opts.embeddings), () => this.index, this.log, opts.embeddingsRetry);
	}

	// ── lifecycle ────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		await mkdir(dirname(this.opts.repoDir), { recursive: true });
		await mkdir(dirname(this.opts.indexPath), { recursive: true });
		if (!existsSync(join(this.opts.repoDir, ".git"))) {
			if (this.opts.remote) {
				const parent = new Git(dirname(this.opts.repoDir), { config: this.gitConfig() });
				await parent.run(["clone", "-q", "--no-checkout", this.opts.remote.url, this.opts.repoDir]);
				const branches = await this.git.out(["branch", "-r"]);
				if (branches.includes(`origin/${this.branch}`)) await this.git.run(["checkout", "-q", "-B", this.branch, `origin/${this.branch}`]);
				else await this.git.run(["symbolic-ref", "HEAD", `refs/heads/${this.branch}`]);
			} else {
				await mkdir(this.opts.repoDir, { recursive: true });
				await this.git.run(["init", "-q", "-b", this.branch]);
			}
		}
		const committer = this.opts.committer ?? { name: "my-memory", email: `my-memory@${this.authorDomain()}` };
		for (const [k, v] of [
			["core.autocrlf", "false"],
			["core.quotepath", "false"],
			["user.name", committer.name],
			["user.email", committer.email],
			["pull.rebase", "true"],
		] as const) {
			await this.git.run(["config", "--local", k, v]);
		}
		this.lfs = await this.git.lfsAvailable();
		if (this.lfs) await this.git.run(["lfs", "install", "--local", "--skip-smudge"], { allowFail: true });

		const head = await this.git.head();
		if (!(await this.git.isClean())) {
			const dirty = (await this.git.out(["status", "--porcelain", "--untracked-files=all"])).trim().split("\n");
			this.log("warn", "worktree.dirty_at_start", { paths: dirty.map((l) => l.slice(3)) });
			await this.restoreWorktree(head);
		}
		await this.loadConventions();
		this.index = new SearchIndex(this.opts.indexPath);
		this.embedder?.checkModel();
		await this.reconcileIndex();
		if (this.embedder) {
			this.log("info", "embeddings.status", this.embedder.status());
			this.embedder.schedule();
		}
		if (this.opts.remote) {
			await this.lock.run(() => this.syncLocked("startup")).catch((error) => this.log("warn", "sync.startup_failed", { error: String(error) }));
		}
		if (this.opts.fetchIntervalMs && this.opts.remote) {
			this.fetchTimer = setInterval(() => this.requestSync("timer"), this.opts.fetchIntervalMs);
			this.fetchTimer.unref();
		}
	}

	async stop(): Promise<void> {
		for (const t of [this.pushTimer, this.fetchTimer, this.syncTimer]) if (t) clearTimeout(t);
		await this.lock.run(async () => undefined);
		await this.embedder?.stop();
		this.index?.close();
	}

	/** Asks for a fetch + integrate soon (webhook or timer). Several requests in a row collapse into one. */
	requestSync(source: string): void {
		this.syncRequested = true;
		if (this.syncTimer) return;
		this.syncTimer = setTimeout(() => {
			this.syncTimer = null;
			this.lock.run(() => this.syncLocked(source)).catch((error) => this.log("warn", "sync.failed", { source, error: String(error) }));
		}, 300);
		this.syncTimer.unref();
	}

	/** Waits until queued writes and syncs are done (tests and shutdown). */
	idle(): Promise<void> {
		return this.lock.run(async () => undefined);
	}

	private gitConfig(): Record<string, string> {
		if (!this.opts.remote?.token) return {};
		const basic = Buffer.from(`${this.opts.remote.username ?? "my-memory"}:${this.opts.remote.token}`).toString("base64");
		return { "http.extraHeader": `Authorization: Basic ${basic}` };
	}

	private authorDomain(): string {
		return this.opts.authorDomain ?? "my-memory.invalid";
	}

	// ── conventions and index ───────────────────────────────────────────────

	private async loadConventions(): Promise<void> {
		const file = join(this.opts.repoDir, CONVENTIONS_FILE);
		let text = "";
		try {
			text = await readFile(file, "utf8");
		} catch {
			this.conventions = defaultConventions();
			this.conventionsHash = "";
			return;
		}
		try {
			this.conventions = parseConventions(text);
			this.conventionsHash = sha256(text);
		} catch (error) {
			// Keep the last valid conventions (or the defaults) and say why.
			this.log("error", "conventions.invalid", { error: (error as Error).message });
		}
	}

	private isRootFile(path: string): boolean {
		return !path.includes("/");
	}

	/** Reads and parses a file for the index. Async part only: the index itself is then updated synchronously. */
	private async prepareFile(path: string): Promise<() => void> {
		if (!path.toLowerCase().endsWith(".md")) return this.isRootFile(path) ? () => undefined : () => this.index.putAsset(path);
		const content = await readFile(join(this.opts.repoDir, path), "utf8");
		const parsed = parseNote(content, this.conventions);
		const name = noteName(path);
		const folder = topFolder(path);
		const root = this.isRootFile(path);
		const archived = this.conventions.folders.archive !== null && folder === this.conventions.folders.archive;
		// Root files and the archive are not held to the note rules.
		const problems = root || archived ? [] : [...parsed.problems];
		const file = path.split("/").pop() as string;
		if (!root && !archived && !this.conventions.notes.filenamePattern.test(file)) problems.push("filename does not match the repo's pattern");
		if (!root && this.conventions.folders.allowed && !this.conventions.folders.allowed.includes(folder)) problems.push(`folder «${folder}» is not in the allowed list`);
		const title = parsed.meta.title ?? firstH1(parsed.body) ?? name;
		const record = {
			path,
			name,
			folder,
			title,
			description: parsed.meta.description,
			aliases: parsed.meta.aliases,
			archived,
			supersededBy: parsed.meta.superseded,
			attachment: parsed.meta.attachment,
			blobHash: blobHash(content),
			size: Buffer.byteLength(content),
			problems,
		};
		const sections = splitSections(parsed.body, parsed.bodyLine, title);
		const links = parseTypedLinks(content);
		if (!root && !archived) for (const relation of this.unknownRelations(links)) problems.push(`relation «${relation}» is not in the allowed list`);
		return () => this.index.putNote(record, sections, links);
	}

	/** Commit dates and authors per path, newest first, for the given log range. */
	private async commitDates(range: string[], paths?: string[]): Promise<Map<string, { updatedAt: string; updatedBy: string; createdAt: string; createdBy: string }>> {
		const out = await this.git.out(["log", "--no-renames", "--format=%x1e%aI%x1f%an", "--name-only", ...range, ...(paths ? ["--", ...paths] : [])]);
		const dates = new Map<string, { updatedAt: string; updatedBy: string; createdAt: string; createdBy: string }>();
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

	private async fullReindex(head: string | null): Promise<void> {
		const started = Date.now();
		const files = head ? (await this.git.out(["ls-files", "-z"])).split("\0").filter(Boolean) : [];
		const dates = head ? await this.commitDates([head]) : new Map();
		const prepared = await Promise.all(files.map((f) => this.prepareFile(f)));
		this.index.db.exec("BEGIN IMMEDIATE");
		try {
			this.index.clearContent();
			for (const apply of prepared) apply();
			for (const f of files) {
				const d = dates.get(f);
				if (d && f.toLowerCase().endsWith(".md")) this.index.setDates(f, d);
			}
			this.index.resolveLinks();
			this.index.setMeta("indexed_commit", head ?? "");
			this.index.setMeta("conventions_hash", this.conventionsHash);
			this.index.db.exec("COMMIT");
		} catch (error) {
			this.index.db.exec("ROLLBACK");
			throw error;
		}
		this.log("info", "index.full", { files: files.length, ms: Date.now() - started, ...this.index.counts() });
		this.embedder?.schedule();
	}

	private async incrementalReindex(from: string, to: string): Promise<void> {
		const started = Date.now();
		const diff = await this.git.out(["diff", "--no-renames", "--name-status", "-z", from, to]);
		const parts = diff.split("\0").filter(Boolean);
		const changed: { status: string; path: string }[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) changed.push({ status: parts[i] as string, path: parts[i + 1] as string });
		if (changed.some((c) => c.path === CONVENTIONS_FILE)) {
			await this.loadConventions();
			if (this.conventionsHash !== (this.index.getMeta("conventions_hash") ?? "")) return this.fullReindex(to);
		}
		const present = changed.filter((c) => !c.status.startsWith("D")).map((c) => c.path);
		const dates = present.length ? await this.commitDates([`${from}..${to}`], present) : new Map();
		for (const p of present) if (!dates.has(p) && p.toLowerCase().endsWith(".md")) {
			const one = await this.commitDates(["-1", to], [p]);
			const d = one.get(p);
			if (d) dates.set(p, d);
		}
		const prepared = new Map<string, () => void>();
		for (const c of changed) if (!c.status.startsWith("D")) prepared.set(c.path, await this.prepareFile(c.path));
		this.index.db.exec("BEGIN IMMEDIATE");
		try {
			for (const c of changed) {
				if (c.status.startsWith("D")) {
					this.index.removeNote(c.path);
					this.index.removeAsset(c.path);
				} else prepared.get(c.path)?.();
			}
			for (const p of present) {
				const d = dates.get(p);
				if (!d || !p.toLowerCase().endsWith(".md")) continue;
				const existing = this.index.getNote(p);
				const isNew = changed.find((c) => c.path === p)?.status.startsWith("A") ?? false;
				this.index.setDates(p, isNew || !existing?.createdAt ? d : { updatedAt: d.updatedAt, updatedBy: d.updatedBy });
			}
			this.index.resolveLinks();
			this.index.setMeta("indexed_commit", to);
			this.index.db.exec("COMMIT");
		} catch (error) {
			this.index.db.exec("ROLLBACK");
			throw error;
		}
		this.log("info", "index.incremental", { changed: changed.length, ms: Date.now() - started });
		this.embedder?.schedule();
	}

	/** Brings the index to HEAD: nothing, incremental, or a full rebuild if it cannot tell what changed. */
	private async reconcileIndex(): Promise<void> {
		const head = await this.git.head();
		const indexed = this.index.getMeta("indexed_commit");
		const sameConventions = (this.index.getMeta("conventions_hash") ?? "") === this.conventionsHash;
		if (indexed !== null && indexed === (head ?? "") && sameConventions) return;
		if (head && indexed && sameConventions && (await this.git.exists(indexed))) return this.incrementalReindex(indexed, head);
		return this.fullReindex(head);
	}

	/** Full rebuild on demand (`my-memory reindex`). `reembed` also drops every vector, so all sections are embedded again. */
	async rebuildIndex(opts: { reembed?: boolean } = {}): Promise<void> {
		await this.lock.run(async () => {
			await this.loadConventions();
			if (opts.reembed) this.index.clearVectors();
			await this.fullReindex(await this.git.head());
		});
	}

	// ── git sync ─────────────────────────────────────────────────────────────

	private async restoreWorktree(head: string | null): Promise<void> {
		if (head) await this.git.run(["reset", "-q", "--hard", head]);
		else await this.git.run(["read-tree", "--empty"], { allowFail: true });
		await this.git.run(["clean", "-fdq"]);
	}

	/**
	 * Fetches and integrates the remote. Fast-forwards when it can, rebases local commits on top otherwise.
	 * On a rebase conflict the remote wins: local commits are dropped (and logged) and the index follows.
	 */
	private async integrateRemoteLocked(): Promise<{ status: "ok" | "unreachable" } | { status: "conflict"; lost: string[] }> {
		const fetched = await this.git.run(["fetch", "-q", "origin", this.branch], { allowFail: true });
		if (fetched.code !== 0) {
			if (/couldn't find remote ref|could not find remote ref/i.test(fetched.stderr)) return { status: "ok" }; // empty remote
			this.log("warn", "git.fetch_failed", { error: fetched.stderr.trim().split("\n").pop() });
			return { status: "unreachable" };
		}
		const remote = (await this.git.run(["rev-parse", "--verify", "-q", `origin/${this.branch}`], { allowFail: true })).stdout.trim();
		const local = await this.git.head();
		if (!remote || remote === local) return { status: "ok" };
		if (!local) {
			await this.git.run(["reset", "-q", "--hard", remote]);
			await this.reconcileAfterMove(null);
			return { status: "ok" };
		}
		const isAncestor = async (a: string, b: string) => (await this.git.run(["merge-base", "--is-ancestor", a, b], { allowFail: true })).code === 0;
		if (await isAncestor(remote, local)) return { status: "ok" }; // we are only ahead
		if (await isAncestor(local, remote)) {
			await this.git.run(["merge", "-q", "--ff-only", remote]);
			await this.reconcileAfterMove(local);
			this.log("info", "git.fast_forward", { from: local, to: remote });
			return { status: "ok" };
		}
		const rebased = await this.git.run(["rebase", "-q", remote], { allowFail: true });
		if (rebased.code === 0) {
			await this.reconcileAfterMove(local);
			this.log("info", "git.rebased", { onto: remote });
			return { status: "ok" };
		}
		await this.git.run(["rebase", "--abort"], { allowFail: true });
		const lost = (await this.git.out(["log", "--format=%H %s", `${remote}..${local}`])).trim().split("\n").filter(Boolean);
		await this.git.run(["reset", "-q", "--hard", remote]);
		await this.git.run(["clean", "-fdq"]);
		await this.reconcileAfterMove(local);
		this.log("error", "git.remote_conflict", { dropped: lost.map((l) => l.split(" ")[0]) });
		return { status: "conflict", lost };
	}

	private async reconcileAfterMove(previous: string | null): Promise<void> {
		const head = await this.git.head();
		const before = this.conventionsHash;
		await this.loadConventions();
		if (!head || !previous || before !== this.conventionsHash || !(await this.git.exists(previous))) return this.fullReindex(head);
		return this.incrementalReindex(previous, head);
	}

	/** Pushes, integrating the remote first when the push is rejected. */
	private async pushLocked(): Promise<{ status: "ok" | "pending" } | { status: "conflict"; lost: string[] }> {
		if (!this.opts.remote) return { status: "ok" };
		for (let attempt = 0; attempt < 3; attempt++) {
			const r = await this.git.run(["push", "-q", "origin", `HEAD:refs/heads/${this.branch}`], { allowFail: true });
			if (r.code === 0) {
				if (this.pushPending) this.log("info", "git.push_recovered", {});
				this.pushPending = false;
				this.pushDelay = this.opts.pushRetry?.initialMs ?? 30_000;
				return { status: "ok" };
			}
			if (/\[rejected\]|non-fast-forward|fetch first|stale info|\[remote rejected\]/.test(r.stderr) && !/remote rejected.*(denied|protected|permission)/i.test(r.stderr)) {
				const integrated = await this.integrateRemoteLocked();
				if (integrated.status === "conflict") return integrated;
				if (integrated.status === "unreachable") break;
				continue;
			}
			this.log("warn", "git.push_failed", { error: r.stderr.trim().split("\n").pop() });
			break;
		}
		this.pushPending = true;
		this.schedulePushRetry();
		return { status: "pending" };
	}

	private schedulePushRetry(): void {
		if (this.pushTimer) return;
		this.pushTimer = setTimeout(() => {
			this.pushTimer = null;
			this.lock
				.run(async () => {
					if (!this.pushPending) return;
					const r = await this.pushLocked();
					if (r.status === "pending") this.pushDelay = Math.min(this.pushDelay * 2, this.opts.pushRetry?.maxMs ?? 600_000);
				})
				.catch((error) => this.log("error", "git.push_retry_failed", { error: String(error) }));
		}, this.pushDelay);
		this.pushTimer.unref();
	}

	private async syncLocked(source: string): Promise<void> {
		this.syncRequested = false;
		if (!this.opts.remote) return;
		const r = await this.integrateRemoteLocked();
		if (r.status === "conflict") return;
		const head = await this.git.head();
		const remote = (await this.git.run(["rev-parse", "--verify", "-q", `origin/${this.branch}`], { allowFail: true })).stdout.trim();
		if (head && head !== remote && r.status === "ok") await this.pushLocked();
		this.log("debug", "sync.done", { source });
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	private abs(path: string): string {
		return join(this.opts.repoDir, ...path.split("/"));
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await lstat(this.abs(path));
			return true;
		} catch {
			return false;
		}
	}

	/** No component of the path may be a symlink: the repo is the only place tools can reach. */
	private async assertNoSymlink(path: string): Promise<void> {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const info = await lstat(this.abs(parts.slice(0, i).join("/"))).catch(() => null);
			if (!info) return;
			if (info.isSymbolicLink()) throw new MemoryError("INVALID_PATH", `«${parts.slice(0, i).join("/")}» is a symlink.`, { path });
		}
	}

	private async readText(path: string): Promise<string> {
		return readFile(this.abs(path), "utf8");
	}

	private async writeText(path: string, content: string | Buffer): Promise<void> {
		const abs = this.abs(path);
		await mkdir(dirname(abs), { recursive: true });
		const tmp = `${abs}.${randomBytes(6).toString("hex")}.tmp`;
		await writeFile(tmp, content, "utf8");
		await rename(tmp, abs);
	}

	private suggestions(input: string): string[] {
		const target = normalizeWords(input);
		return this.index
			.allNotes()
			.map((n) => {
				const labels = [n.name, n.title ?? "", ...n.aliases].map(normalizeWords).filter(Boolean);
				const best = Math.min(...labels.map((l) => levenshtein(l, target) / Math.max(l.length, target.length, 1)));
				return { path: n.path, best, same: labels.some((l) => looksLikeSame(l, target)) };
			})
			.filter((x) => x.same || x.best <= 0.4)
			.sort((a, b) => a.best - b.best)
			.slice(0, 5)
			.map((x) => x.path);
	}

	/** Finds the note a client means, by path or by name (`x`, `[[x]]`, `x.md`). */
	resolveNote(ref: NoteRef): NoteRow {
		const hasPath = typeof ref.path === "string" && ref.path.trim() !== "";
		const hasName = typeof ref.name === "string" && ref.name.trim() !== "";
		if (hasPath === hasName) throw new MemoryError("INVALID_ARGUMENT", "Give either «path» or «name».");
		if (hasPath) {
			const path = checkPath(ref.path, this.conventions, "note");
			const row = this.index.getNote(path);
			if (!row) throw new MemoryError("NOT_FOUND", `No note at «${path}».`, { suggestions: this.suggestions(noteName(path)) });
			return row;
		}
		const name = (ref.name as string)
			.trim()
			.replace(/^!?\[\[|\]\]$/g, "")
			.replace(/[#|].*$/, "")
			.split("/")
			.pop()
			?.replace(/\.md$/i, "") as string;
		const rows = this.index.notesByName(name);
		if (rows.length === 0) throw new MemoryError("NOT_FOUND", `No note named «${name}».`, { suggestions: this.suggestions(name) });
		if (rows.length > 1) throw new MemoryError("INVALID_ARGUMENT", `Several notes are named «${name}»; use «path».`, { paths: rows.map((r) => r.path) });
		return rows[0] as NoteRow;
	}

	/**
	 * Frontmatter rules for a write. A note whose frontmatter was already broken (old notes, hand edits) can still
	 * be edited as long as the frontmatter itself is left untouched; the problem comes back as a warning.
	 */
	private validateNote(path: string, content: string, previous?: string): Warning[] {
		if (this.isRootFile(path)) return [];
		const parsed = parseNote(content, this.conventions);
		if (parsed.problems.length === 0) return [];
		if (previous !== undefined && splitFrontmatter(previous).yaml === parsed.yaml) {
			return [{ code: "FRONTMATTER_PROBLEMS", message: `The frontmatter was already invalid and was left as it was: ${parsed.problems.join("; ")}. Fix it when you can.`, problems: parsed.problems }];
		}
		throw new MemoryError("INVALID_FRONTMATTER", `Invalid frontmatter: ${parsed.problems.join("; ")}.`, { problems: parsed.problems, path });
	}

	/** Relation keys used in the links that `memory.toml` does not allow, in order of appearance. */
	private unknownRelations(links: { relation: string | null }[]): string[] {
		const allowed = this.conventions.relations.allowed;
		if (!allowed) return [];
		return [...new Set(links.map((l) => l.relation).filter((r): r is string => r !== null && !allowed.includes(r)))];
	}

	/** Warnings about a note's links on write: targets that do not exist, and relation keys outside the allowed list. */
	private linkWarnings(content: string, selfPath: string): Warning[] {
		const self = noteName(selfPath).toLowerCase();
		const links = parseTypedLinks(content);
		const missing = new Set<string>();
		for (const link of links) {
			if (link.targetName === self) continue;
			if (this.index.notesByName(link.targetName).length > 0) continue;
			if (this.index.assetsByName(link.targetName).length > 0) continue;
			missing.add(link.rawTarget);
		}
		const warnings: Warning[] = [];
		if (missing.size) warnings.push({ code: "BROKEN_LINKS", message: `Links to notes that do not exist yet: ${[...missing].join(", ")}.`, targets: [...missing] });
		const unknown = this.isRootFile(selfPath) ? [] : this.unknownRelations(links);
		if (unknown.length) {
			warnings.push({
				code: "UNKNOWN_RELATIONS",
				message: `Relation keys not in this memory's list: ${unknown.join(", ")}. Use one of: ${this.conventions.relations.allowed?.join(", ")}.`,
				relations: unknown,
			});
		}
		return warnings;
	}

	private duplicateCandidates(labels: string[], exclude?: string): { path: string; name: string; description: string | null }[] {
		const wanted = labels.filter((l) => normalizeWords(l));
		return this.index
			.allNotes()
			.filter((n) => n.path !== exclude)
			.filter((n) => lookAlikeLabels(noteLabels(n), wanted) !== null)
			.slice(0, 10)
			.map((n) => ({ path: n.path, name: n.name, description: n.description }));
	}

	private checkReason(reason: unknown): string {
		if (typeof reason !== "string" || reason.trim() === "") throw new MemoryError("INVALID_ARGUMENT", "«reason» is required: one line saying why this change is made.");
		const line = reason.replace(/\s+/g, " ").trim();
		if (line.length > 300) throw new MemoryError("INVALID_ARGUMENT", "«reason» must be at most 300 characters.");
		return line;
	}

	private checkHash(path: string, current: string, hash: unknown, required: boolean): void {
		if (hash === undefined || hash === null || hash === "") {
			if (required) throw new MemoryError("INVALID_ARGUMENT", "«hash» is required: read the note first and pass the hash you got.");
			return;
		}
		const now = blobHash(current);
		if (hash !== now) throw new MemoryError("CONFLICT", `«${path}» changed since you read it.`, { path, hash: now, content: current });
	}

	private commitMessage(client: ClientIdentity, tool: string, reason: string, extra: Record<string, string> = {}): string {
		const trailers = [`Client: ${client.id}`, `Tool: ${tool}`];
		if (client.session) trailers.push(`Session: ${client.session.replace(/\s+/g, " ").slice(0, 200)}`);
		for (const [key, value] of Object.entries(extra)) trailers.push(`${key}: ${value}`);
		return `${reason}\n\n${trailers.join("\n")}\n`;
	}

	private authorEnv(client: ClientIdentity): Record<string, string> {
		const local = client.id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "client";
		return { GIT_AUTHOR_NAME: client.name, GIT_AUTHOR_EMAIL: `${local}@${this.authorDomain()}` };
	}

	/**
	 * Runs one write: apply the change to the worktree, commit it, reindex, push.
	 * Everything happens under the write lock; if anything fails before the commit, the worktree goes back to HEAD.
	 */
	private mutate(
		client: ClientIdentity,
		tool: string,
		rawReason: unknown,
		apply: () => Promise<{ paths: string[]; result: { path: string; [k: string]: unknown }; warnings?: Warning[]; contentPath?: string; trailers?: Record<string, string> }>,
	): Promise<WriteResult> {
		if (client.scope !== "write") return Promise.reject(READ_ONLY);
		let reason: string;
		try {
			reason = this.checkReason(rawReason);
		} catch (error) {
			return Promise.reject(error);
		}
		return this.lock.run(async () => {
			if (this.syncRequested) await this.syncLocked("before-write");
			const before = await this.git.head();
			let applied: Awaited<ReturnType<typeof apply>>;
			try {
				applied = await apply();
				const paths = [...new Set(applied.paths)];
				await this.git.run(["add", "-A", "--", ...paths]);
				const staged = await this.git.run(["diff", "--cached", "--quiet"], { allowFail: true });
				if (staged.code === 0) {
					const contentPath = applied.contentPath ?? applied.result.path;
					const hash = (await this.exists(contentPath)) ? blobHash(await this.readText(contentPath)) : null;
					return { commit: before, hash, ...applied.result, warnings: [...(applied.warnings ?? []), { code: "NO_CHANGES" as const, message: "Nothing changed; no commit was made." }] };
				}
				await this.git.run(["commit", "-q", "--no-verify", "-F", "-"], { input: this.commitMessage(client, tool, reason, applied.trailers), env: this.authorEnv(client) });
			} catch (error) {
				await this.restoreWorktree(before).catch((e) => this.log("error", "worktree.restore_failed", { error: String(e) }));
				throw error;
			}
			const commit = (await this.git.head()) as string;
			if (before) await this.incrementalReindex(before, commit);
			else await this.fullReindex(commit);
			const warnings = [...(applied.warnings ?? [])];
			const pushed = await this.pushLocked();
			const contentPath = applied.contentPath ?? applied.result.path;
			if (pushed.status === "conflict") {
				const current = (await this.exists(contentPath)) ? await this.readText(contentPath) : null;
				throw new MemoryError("REMOTE_CONFLICT", "Someone changed the memory at the same time and the changes collided; yours was not kept. Read the note again and redo the change.", {
					path: contentPath,
					hash: current === null ? null : blobHash(current),
					content: current,
				});
			}
			if (pushed.status === "pending") warnings.push({ code: "PUSH_PENDING", message: "Saved and committed here, but the remote is unreachable; it will be pushed automatically." });
			const hash = (await this.exists(contentPath)) && contentPath.endsWith(".md") ? blobHash(await this.readText(contentPath)) : null;
			const finalCommit = (await this.git.head()) as string;
			this.log("info", "memory.write", { client: client.id, tool, path: applied.result.path, commit: finalCommit.slice(0, 12), warnings: warnings.map((w) => w.code) });
			return { commit: finalCommit, hash, ...applied.result, warnings };
		});
	}

	// ── read tools ───────────────────────────────────────────────────────────

	shortIndex(includeArchive = false): {
		full: { folder: string; notes: { path: string; name: string; title: string | null; description: string | null; aliases: string[] }[] }[];
		folders: { folder: string; count: number; names: string[]; more: number }[];
	} {
		const counts = this.index.folderCounts(includeArchive).filter((c) => c.folder !== "");
		const full = this.conventions.folders.indexFull
			.filter((f) => counts.some((c) => c.folder === f))
			.map((folder) => ({
				folder,
				notes: this.index.listNotes({ folder, includeArchive, limit: 10_000, offset: 0 }).map((n) => ({ path: n.path, name: n.name, title: n.title, description: n.description, aliases: n.aliases })),
			}));
		const folders = counts
			.filter((c) => !this.conventions.folders.indexFull.includes(c.folder))
			.map((c) => {
				const names = this.index.listNotes({ folder: c.folder, includeArchive, limit: 8, offset: 0 }).map((n) => n.name);
				return { folder: c.folder, count: c.count, names, more: Math.max(0, c.count - names.length) };
			});
		return { full, folders };
	}

	renderShortIndex(): string {
		const { full, folders } = this.shortIndex();
		const lines: string[] = [];
		for (const f of full) {
			lines.push(`${f.folder}/ (${f.notes.length})`);
			for (const n of f.notes) {
				const aliases = n.aliases.length ? ` [aliases: ${n.aliases.join(", ")}]` : "";
				lines.push(`- [[${n.name}]] — ${n.title ?? n.name}: ${n.description ?? ""}${aliases}`);
			}
		}
		for (const f of folders) lines.push(`${f.folder}/ (${f.count}): ${f.names.join(", ")}${f.more ? `, and ${f.more} more` : ""}`);
		if (this.conventions.folders.archive) lines.push(`(${this.conventions.folders.archive}/ is archived: excluded from list and search unless include_archive is set)`);
		return lines.join("\n");
	}

	/** What the server sends as MCP `instructions`: the repo's rules file plus the short index. */
	async instructions(): Promise<string> {
		const parts = [
			"This server is a shared, git-versioned memory of Markdown notes. Every write is a commit attributed to you; give a one-line `reason` in the user's language. Search before creating notes; read a note before rewriting it and pass back its `hash`. Link notes with [[name]]. To say how two notes relate, write the link as a field, `key:: [[name]]` on its own line or `[key:: [[name]]]` inside a sentence; `links` can then filter by that key.",
			`If this host is not set up to use this memory yet, follow the \`setup\` prompt or the \`${SETUP_GUIDE_URI}\` resource (or ${SETUP_GUIDE_URL}).`,
		];
		const allowed = this.conventions.relations.allowed;
		const inUse = this.index.relations().map((r) => r.relation);
		if (allowed) parts.push(`Relation keys of this memory: ${allowed.join(", ")}.`);
		else if (inUse.length) parts.push(`Relation keys already in use (reuse them rather than inventing synonyms): ${inUse.join(", ")}.`);
		const file = this.conventions.instructions.file;
		if (file) {
			const text = await readFile(this.abs(file), "utf8").catch(() => null);
			if (text) parts.push(`## Rules of this memory (${file})\n\n${text.trim()}`);
		}
		parts.push(`## Index\n\n${this.renderShortIndex()}`);
		return parts.join("\n\n");
	}

	list(args: { folder?: string; include_archive?: boolean; limit?: number; cursor?: string }) {
		if (!args.folder) return { index: this.shortIndex(args.include_archive ?? false) };
		const folder = args.folder.replace(/\/+$/, "");
		const includeArchive = args.include_archive ?? folder === this.conventions.folders.archive;
		const counts = this.index.folderCounts(true);
		if (!counts.some((c) => c.folder === folder)) {
			throw new MemoryError("NOT_FOUND", `No folder «${folder}».`, { folders: counts.map((c) => c.folder).filter(Boolean) });
		}
		const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
		const offset = args.cursor ? Number.parseInt(args.cursor, 10) || 0 : 0;
		const rows = this.index.listNotes({ folder, includeArchive, limit: limit + 1, offset });
		return {
			folder,
			notes: rows.slice(0, limit).map((n) => ({
				path: n.path,
				name: n.name,
				title: n.title,
				description: n.description,
				aliases: n.aliases,
				updated_at: n.updatedAt,
				updated_by: n.updatedBy,
				...(n.supersededBy ? { superseded_by: n.supersededBy } : {}),
				...(n.problems.length ? { problems: n.problems } : {}),
			})),
			...(rows.length > limit ? { next_cursor: String(offset + limit) } : {}),
		};
	}

	private searchOpts(args: SearchArgs) {
		return { folder: args.folder ? args.folder.replace(/\/+$/, "") : null, includeArchive: args.include_archive ?? false, limit: Math.min(Math.max(args.limit ?? 10, 1), 50) };
	}

	private ftsQuery(args: SearchArgs) {
		const q = buildFtsQuery(args.query ?? "");
		if (!q) throw new MemoryError("INVALID_ARGUMENT", "The query has no words to search for.");
		return q;
	}

	private textHits(args: SearchArgs, limit?: number): { mode: "all" | "any"; hits: SearchHit[] } {
		const q = this.ftsQuery(args);
		const opts = { ...this.searchOpts(args), ...(limit ? { limit } : {}) };
		let mode: "all" | "any" = "all";
		let hits = this.index.search(q.and, opts);
		if (hits.length === 0 && q.or !== q.and) {
			hits = this.index.search(q.or, opts);
			mode = "any";
		}
		return { mode, hits };
	}

	private static hitsOut(hits: (SearchHit | null)[]) {
		return hits
			.filter((h): h is SearchHit => h !== null)
			.map((h) => ({ path: h.path, name: h.name, description: h.description, section: { heading: h.section.heading, level: h.section.level, line_start: h.section.lineStart, line_end: h.section.lineEnd }, snippet: h.snippet, score: h.score }));
	}

	/** Full-text search only (bm25). */
	search(args: SearchArgs) {
		const { mode, hits } = this.textHits(args);
		return { mode, hits: MemoryService.hitsOut(hits) };
	}

	/**
	 * The `search` tool. With embeddings configured, `hybrid` (the default) fuses the full-text ranking with the
	 * ranking by cosine similarity to the query's vector (Reciprocal Rank Fusion), and `semantic` uses the vectors
	 * alone. If the query cannot be embedded, the answer is the full-text search, the same as without embeddings.
	 */
	async searchAny(args: SearchArgs & { mode?: SearchMode }) {
		const want = this.embedder ? (args.mode ?? "hybrid") : "text";
		if (want === "text") return this.search(args);
		const opts = this.searchOpts(args);
		const pool = Math.max(opts.limit * 3, 30);
		this.ftsQuery(args); // the same error as a text search, before calling the endpoint
		const vector = await (this.embedder as Embedder).embedQuery(args.query);
		if (!vector) return this.search(args);
		// Everything below reads the index synchronously, after the await: a reindex cannot renumber the sections in between.
		const ranked = this.index
			.sectionVectors(opts)
			.filter((s) => s.vector.length === vector.length)
			.map((s) => ({ id: s.sectionId, similarity: dot(s.vector, vector) }))
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, pool);
		const round = (x: number) => Math.round(x * 10_000) / 10_000;
		if (want === "semantic") {
			return { mode: "semantic" as const, hits: MemoryService.hitsOut(ranked.slice(0, opts.limit).map((r) => this.index.sectionHit(r.id, round(r.similarity)))) };
		}
		const text = this.textHits(args, pool);
		const byId = new Map(text.hits.map((h) => [h.sectionId, h]));
		const fused = [...reciprocalRankFusion([text.hits.map((h) => h.sectionId), ranked.map((r) => r.id)])].sort((a, b) => b[1] - a[1]).slice(0, opts.limit);
		const hits = fused.map(([id, score]) => {
			const h = byId.get(id);
			return h ? { ...h, score: round(score) } : this.index.sectionHit(id, round(score));
		});
		return { mode: "hybrid" as const, hits: MemoryService.hitsOut(hits) };
	}

	async read(args: NoteRef & { section?: string; revision?: string }) {
		let path: string;
		let content: string;
		let row: NoteRow | null = null;
		if (args.revision) {
			const rev = args.revision.trim();
			if (!/^[\w./~^@{}-]+$/.test(rev) || rev.startsWith("-") || !(await this.git.exists(rev))) throw new MemoryError("INVALID_REVISION", `Unknown revision «${args.revision}».`);
			path = args.path ? checkPath(args.path, this.conventions, "note") : this.resolveNote(args).path;
			const shown = await this.git.run(["show", `${rev}:${path}`], { allowFail: true });
			if (shown.code !== 0) throw new MemoryError("NOT_FOUND", `«${path}» does not exist at ${rev}.`);
			content = shown.stdout;
		} else {
			row = this.resolveNote(args);
			path = row.path;
			content = await this.readText(path);
		}
		const parsed = parseNote(content, this.conventions);
		const title = parsed.meta.title ?? firstH1(parsed.body) ?? noteName(path);
		const sections = splitSections(parsed.body, parsed.bodyLine, title);
		let body = content;
		if (args.section) {
			const want = normalizeWords(args.section.replace(/^#+\s*/, ""));
			const found = sections.find((s) => normalizeWords(s.heading) === want);
			if (!found) throw new MemoryError("SECTION_NOT_FOUND", `No section «${args.section}» in «${path}».`, { headings: sections.map((s) => s.heading) });
			body = found.text;
		}
		const dupes = row ? this.index.notesByName(row.name).filter((n) => n.path !== path).map((n) => n.path) : [];
		const problems = [...(row?.problems ?? []), ...dupes.map((p) => `duplicate name: also at ${p}`)];
		return {
			path,
			name: noteName(path),
			hash: blobHash(content),
			frontmatter: parsed.meta.fields,
			content: body,
			sections: sections.map((s) => ({ heading: s.heading, level: s.level, line_start: s.lineStart })),
			...(row
				? {
						updated_at: row.updatedAt,
						updated_by: row.updatedBy,
						links_out: this.index.linksOut(path).length,
						links_in: this.index.linksIn(path).filter((l) => l.srcPath !== path).length,
					}
				: { revision: args.revision }),
			...(problems.length ? { problems } : {}),
		};
	}

	async links(args: NoteRef & { direction?: "in" | "out" | "both"; relation?: string }) {
		const row = this.resolveNote(args);
		const direction = args.direction ?? "both";
		const relation = args.relation?.trim().replace(/::?$/, "").toLowerCase() || undefined;
		const result: Record<string, unknown> = { path: row.path, ...(relation ? { relation } : {}) };
		if (direction !== "in") {
			result.out = this.index.linksOut(row.path, relation).map((l) => ({
				target_name: l.targetName,
				target_path: l.targetPath,
				...(l.heading ? { heading: l.heading } : {}),
				...(l.embed ? { embed: true } : {}),
				...(l.relation ? { relation: l.relation } : {}),
				line: l.line,
			}));
		}
		if (direction !== "out") {
			const incoming = [...this.index.linksIn(row.path, relation)];
			if (row.attachment) incoming.push(...this.index.linksIn(joinPath(dirOf(row.path), row.attachment), relation));
			const texts = new Map<string, string[]>();
			const inList = [];
			for (const l of incoming) {
				if (l.srcPath === row.path) continue;
				if (!texts.has(l.srcPath)) texts.set(l.srcPath, (await this.readText(l.srcPath).catch(() => "")).split("\n"));
				const context = (texts.get(l.srcPath)?.[l.line - 1] ?? "").trim();
				inList.push({ src_path: l.srcPath, ...(l.relation ? { relation: l.relation } : {}), line: l.line, context: context.length > 240 ? `${context.slice(0, 237)}…` : context });
			}
			result.in = inList;
		}
		return result;
	}

	async history(args: NoteRef & { limit?: number }) {
		let path: string;
		if (args.path) {
			path = checkPath(args.path, this.conventions, "note");
		} else path = this.resolveNote(args).path;
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
		const out = await this.git.out(["log", "--follow", `-n${limit}`, "--format=%x1e%H%x1f%aI%x1f%an%x1f%ae%x1f%s%x1f%(trailers:only=true,unfold=true)", "--", path]);
		const commits = out
			.split("\x1e")
			.filter((b) => b.trim())
			.map((b) => {
				const [commit, date, author, email, message, trailerText] = b.split("\x1f") as string[];
				const trailers: Record<string, string> = {};
				for (const line of (trailerText ?? "").split("\n")) {
					const m = /^([\w-]+):\s*(.*)$/.exec(line.trim());
					if (m) trailers[m[1] as string] = m[2] as string;
				}
				return { commit, date, author, email, message, trailers };
			});
		if (commits.length === 0) throw new MemoryError("NOT_FOUND", `No history for «${path}».`);
		return { path, commits };
	}

	/**
	 * The latest commits on the branch, newest first, with the files each one touched.
	 * Files only in the archive are left out (and commits that touched nothing else) unless include_archive.
	 */
	async recent(args: { limit?: number; since?: string; folder?: string; client?: string; include_archive?: boolean }): Promise<{ commits: RecentCommit[]; since?: string }> {
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
		const since = args.since?.trim() ? parseSince(args.since) : null;
		const folder = args.folder ? args.folder.trim().replace(/^\.\/|\/+$/g, "") : null;
		if (folder !== null && (folder === "" || folder.startsWith("-") || folder.split("/").some((p) => p === "" || p.startsWith(".")))) {
			throw new MemoryError("INVALID_ARGUMENT", `Invalid folder «${args.folder}».`);
		}
		const archive = this.conventions.folders.archive;
		const includeArchive = args.include_archive ?? (folder !== null && folder === archive);
		const hidden = (p: string) => !includeArchive && archive !== null && topFolder(p) === archive;
		const client = args.client?.trim().toLowerCase() || null;
		if (!(await this.git.head())) return { commits: [] };
		const commits: RecentCommit[] = [];
		// Filters that drop commits after git has listed them read the log in pages.
		const page = client || since || !includeArchive ? Math.max(limit * 4, 100) : limit;
		for (let skip = 0; commits.length < limit; skip += page) {
			const out = await this.git.out([
				"log",
				`-n${page}`,
				`--skip=${skip}`,
				"-M",
				"--name-status",
				"--format=%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%(trailers:only=true,unfold=true)%x1f",
				...(since ? [`--since=${since}`] : []),
				...(folder ? ["--full-diff", "--", `${folder}/`] : []),
			]);
			const blocks = out.split("\x1e").filter((b) => b.trim());
			for (const block of blocks) {
				const [commit, date, author, reason, trailerText, files] = block.split("\x1f") as string[];
				const trailers: Record<string, string> = {};
				for (const line of (trailerText ?? "").split("\n")) {
					const m = /^([\w-]+):\s*(.*)$/.exec(line.trim());
					if (m) trailers[m[1] as string] = m[2] as string;
				}
				if (client && trailers.Client?.toLowerCase() !== client && author?.toLowerCase() !== client) continue;
				if (since && Date.parse(date as string) < Date.parse(since)) continue; // git's --since is a hint, not exact
				const changes = parseNameStatus(files ?? "");
				const visible = changes.filter((c) => !hidden(c.path) || (c.from !== undefined && !hidden(c.from)));
				if (changes.length > 0 && visible.length === 0) continue;
				commits.push({
					commit: commit as string,
					date: date as string,
					author: author as string,
					client: trailers.Client ?? null,
					tool: trailers.Tool ?? null,
					...(trailers.Session ? { session: trailers.Session } : {}),
					...(trailers.Reverts ? { reverts: trailers.Reverts } : {}),
					reason: reason as string,
					notes: visible.map((c) => ({
						path: c.path,
						...(/\.md$/i.test(c.path) ? { name: noteName(c.path) } : {}),
						change: CHANGE_NAMES[c.status] ?? "modified",
						...(c.from ? { from: c.from } : {}),
					})),
				});
				if (commits.length === limit) break;
			}
			if (blocks.length < page) break;
		}
		return { commits, ...(since ? { since } : {}) };
	}

	/** Maintenance worklist from the index (see lint.ts). `nowMs` is for tests. */
	lint(args: LintArgs = {}, nowMs: number = Date.now()) {
		return lint(this.index, this.conventions, args, nowMs);
	}

	// ── write tools ──────────────────────────────────────────────────────────

	create(client: ClientIdentity, args: { path: string; content: string; reason: string; confirm_new?: boolean }): Promise<WriteResult> {
		return this.mutate(client, "create", args.reason, async () => {
			const path = checkPath(args.path, this.conventions, "note");
			if (!this.isRootFile(path)) checkNewFilename(path, this.conventions);
			await this.assertNoSymlink(path);
			if (typeof args.content !== "string") throw new MemoryError("INVALID_ARGUMENT", "«content» is required.");
			if (await this.exists(path)) throw new MemoryError("ALREADY_EXISTS", `«${path}» already exists; use edit or write.`, { path });
			const name = noteName(path);
			const taken = this.index.notesByName(name);
			if (taken.length) throw new MemoryError("NAME_TAKEN", `A note named «${name}» already exists at ${taken[0]?.path}; names must be unique across folders.`, { existing: taken.map((t) => t.path) });
			this.validateNote(path, args.content);
			if (!args.confirm_new) {
				const meta = parseNote(args.content, this.conventions).meta;
				const candidates = this.duplicateCandidates([name.replace(/-/g, " "), meta.title ?? "", ...meta.aliases]);
				if (candidates.length) {
					throw new MemoryError("DUPLICATE_CANDIDATES", "Some existing notes look like the same thing. Read them; if this really is new, call create again with confirm_new: true.", { candidates });
				}
			}
			await this.writeText(path, args.content);
			return { paths: [path], result: { path }, warnings: this.linkWarnings(args.content, path) };
		});
	}

	edit(client: ClientIdentity, args: NoteRef & { edits: { old_string: string; new_string: string; replace_all?: boolean }[]; reason: string; hash?: string }): Promise<WriteResult> {
		return this.mutate(client, "edit", args.reason, async () => {
			const row = this.resolveNote(args);
			await this.assertNoSymlink(row.path);
			const current = await this.readText(row.path);
			this.checkHash(row.path, current, args.hash, false);
			if (!Array.isArray(args.edits) || args.edits.length === 0) throw new MemoryError("INVALID_ARGUMENT", "«edits» must be a non-empty list.");
			const crlf = current.includes("\r\n");
			let text = current;
			args.edits.forEach((e, i) => {
				if (typeof e.old_string !== "string" || e.old_string === "" || typeof e.new_string !== "string") throw new MemoryError("INVALID_ARGUMENT", `Edit ${i}: old_string must be non-empty and new_string a string.`, { edit: i });
				let oldS = e.old_string;
				let newS = e.new_string;
				let count = text.split(oldS).length - 1;
				if (count === 0 && crlf && oldS.includes("\n") && !oldS.includes("\r\n")) {
					oldS = oldS.replace(/\n/g, "\r\n");
					newS = newS.replace(/\r?\n/g, "\r\n");
					count = text.split(oldS).length - 1;
				}
				if (count === 0) throw new MemoryError("EDIT_NO_MATCH", `Edit ${i}: old_string was not found${i > 0 ? " (after applying the previous edits)" : ""}.`, { edit: i });
				if (count > 1 && !e.replace_all) throw new MemoryError("EDIT_AMBIGUOUS", `Edit ${i}: old_string appears ${count} times; add context or set replace_all.`, { edit: i, occurrences: count });
				if (e.replace_all) text = text.split(oldS).join(newS);
				else {
					const at = text.indexOf(oldS);
					text = text.slice(0, at) + newS + text.slice(at + oldS.length);
				}
			});
			const fmWarnings = this.validateNote(row.path, text, current);
			await this.writeText(row.path, text);
			return { paths: [row.path], result: { path: row.path }, warnings: [...fmWarnings, ...this.linkWarnings(text, row.path)] };
		});
	}

	write(client: ClientIdentity, args: NoteRef & { content: string; hash: string; reason: string }): Promise<WriteResult> {
		return this.mutate(client, "write", args.reason, async () => {
			const row = this.resolveNote(args);
			await this.assertNoSymlink(row.path);
			const current = await this.readText(row.path);
			this.checkHash(row.path, current, args.hash, true);
			if (typeof args.content !== "string") throw new MemoryError("INVALID_ARGUMENT", "«content» is required.");
			const fmWarnings = this.validateNote(row.path, args.content, current);
			await this.writeText(row.path, args.content);
			return { paths: [row.path], result: { path: row.path }, warnings: [...fmWarnings, ...this.linkWarnings(args.content, row.path)] };
		});
	}

	move(client: ClientIdentity, args: { from: string; to: string; hash: string; reason: string }): Promise<WriteResult> {
		return this.mutate(client, "move", args.reason, async () => {
			if (typeof args.from !== "string" || !args.from.trim()) throw new MemoryError("INVALID_ARGUMENT", "«from» is required: a path or a name.");
			const row = this.resolveNote(args.from.includes("/") || /\.md$/i.test(args.from.trim()) ? { path: args.from } : { name: args.from });
			if (this.isRootFile(row.path)) throw new MemoryError("INVALID_PATH", `«${row.path}» is a root file and cannot be moved.`);
			const to = checkPath(args.to, this.conventions, "note");
			if (this.isRootFile(to)) throw new MemoryError("INVALID_PATH", "Notes cannot be moved to the repo root.");
			checkNewFilename(to, this.conventions);
			if (to === row.path) throw new MemoryError("INVALID_ARGUMENT", "«to» is the same as the current path.");
			await this.assertNoSymlink(row.path);
			await this.assertNoSymlink(to);
			const current = await this.readText(row.path);
			this.checkHash(row.path, current, args.hash, true);
			const caseOnly = to.toLowerCase() === row.path.toLowerCase();
			if (!caseOnly && (await this.exists(to))) throw new MemoryError("ALREADY_EXISTS", `«${to}» already exists.`, { path: to });
			const oldName = row.name;
			const newName = noteName(to);
			const renamed = oldName.toLowerCase() !== newName.toLowerCase() || oldName !== newName;
			if (oldName.toLowerCase() !== newName.toLowerCase()) {
				const taken = this.index.notesByName(newName).filter((n) => n.path !== row.path);
				if (taken.length) throw new MemoryError("NAME_TAKEN", `A note named «${newName}» already exists at ${taken[0]?.path}.`, { existing: taken.map((t) => t.path) });
			}
			const paths = [row.path, to];
			// Binary of an attachment companion follows its note to the new folder.
			if (row.attachment && dirOf(row.path) !== dirOf(to)) {
				const fromBin = joinPath(dirOf(row.path), row.attachment);
				const toBin = joinPath(dirOf(to), row.attachment);
				if (await this.exists(toBin)) throw new MemoryError("ALREADY_EXISTS", `«${toBin}» already exists.`, { path: toBin });
				if (await this.exists(fromBin)) {
					await mkdir(dirname(this.abs(toBin)), { recursive: true });
					await rename(this.abs(fromBin), this.abs(toBin));
					paths.push(fromBin, toBin);
				}
			}
			await mkdir(dirname(this.abs(to)), { recursive: true });
			if (caseOnly) {
				const tmp = `${this.abs(row.path)}.${randomBytes(4).toString("hex")}.mv`;
				await rename(this.abs(row.path), tmp);
				await rename(tmp, this.abs(to));
			} else await rename(this.abs(row.path), this.abs(to));
			let rewritten = 0;
			if (renamed) {
				const oldKey = oldName.toLowerCase();
				const referrers = new Set(this.index.linksIn(row.path).map((l) => l.srcPath));
				referrers.add(row.path);
				for (const src of referrers) {
					const file = src === row.path ? to : src;
					const text = await this.readText(file);
					const out = rewriteWikiLinks(text, (l) => (l.targetName === oldKey ? newName : null));
					if (out.count > 0) {
						await this.writeText(file, out.text);
						paths.push(file);
						rewritten += out.count;
					}
				}
			}
			return { paths, result: { path: to, from: row.path, links_rewritten: rewritten } };
		});
	}

	delete(client: ClientIdentity, args: NoteRef & { hash: string; reason: string }): Promise<WriteResult> {
		return this.mutate(client, "delete", args.reason, async () => {
			const row = this.resolveNote(args);
			if (this.isRootFile(row.path)) throw new MemoryError("INVALID_PATH", `«${row.path}» is a root file and cannot be deleted.`);
			await this.assertNoSymlink(row.path);
			const current = await this.readText(row.path);
			this.checkHash(row.path, current, args.hash, true);
			const binary = row.attachment ? joinPath(dirOf(row.path), row.attachment) : null;
			const backlinks = [...this.index.linksIn(row.path), ...(binary ? this.index.linksIn(binary) : [])].filter((l) => l.srcPath !== row.path);
			if (backlinks.length) {
				throw new MemoryError("HAS_BACKLINKS", `Other notes link to «${row.name}»; fix or remove those links first.`, { backlinks: backlinks.map((l) => ({ src_path: l.srcPath, line: l.line })) });
			}
			await rm(this.abs(row.path));
			const paths = [row.path];
			if (binary && (await this.exists(binary))) {
				await rm(this.abs(binary));
				paths.push(binary);
			}
			return { paths, result: { path: row.path } };
		});
	}

	/** Full hash of a commit given by a client, which must be on the current branch. */
	private async branchCommit(input: unknown): Promise<string> {
		const rev = typeof input === "string" ? input.trim() : "";
		if (!rev) throw new MemoryError("INVALID_ARGUMENT", "«commit» is required: a hash from `recent` or `history`.");
		if (!/^[\w./~^@{}-]+$/.test(rev) || rev.startsWith("-") || !(await this.git.exists(rev))) throw new MemoryError("INVALID_REVISION", `Unknown commit «${rev}».`);
		const full = (await this.git.out(["rev-parse", "--verify", `${rev}^{commit}`])).trim();
		const onBranch = (await this.git.run(["merge-base", "--is-ancestor", full, "HEAD"], { allowFail: true })).code === 0;
		if (!onBranch) throw new MemoryError("INVALID_REVISION", `Commit «${rev}» is not part of the memory's history (branch ${this.branch}).`);
		return full;
	}

	/** Blob id of a file at a revision, or null when it does not exist there. */
	private async blobAt(rev: string, path: string): Promise<string | null> {
		const r = await this.git.run(["rev-parse", "-q", "--verify", `${rev}:${path}`], { allowFail: true });
		return r.code === 0 ? r.stdout.trim() : null;
	}

	private async blobText(id: string): Promise<string> {
		return this.git.out(["cat-file", "blob", id]);
	}

	/** A blob as raw bytes, for files copied from history unchanged (no round trip through UTF-8). */
	private async blobBytes(id: string): Promise<Buffer> {
		return this.git.bytes(["cat-file", "blob", id]);
	}

	/** Three-way merge of text (`git merge-file`): the result, or null when the changes overlap. */
	private async mergeText(ours: string, base: string, theirs: string): Promise<string | null> {
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

	/**
	 * Undoes a commit, or only what it did to one note: every file it touched goes back to its state before it,
	 * as one new commit. Later changes to the same files are kept when they do not overlap (three-way merge);
	 * otherwise nothing is changed and it fails with REVERT_CONFLICT. Binaries are never rewritten from history:
	 * they can be removed (undoing an attach) or moved back, but not restored. `.gitattributes` is left alone.
	 */
	revert(client: ClientIdentity, args: NoteRef & { commit: string; reason: string }): Promise<WriteResult> {
		return this.mutate(
			client,
			"revert",
			args.reason,
			async () => {
				const target = await this.branchCommit(args.commit);
				const short = target.slice(0, 12);
				const parents = (await this.git.out(["rev-list", "--parents", "-n1", target])).trim().split(" ").slice(1);
				if (parents.length > 1) throw new MemoryError("INVALID_REVISION", `«${short}» is a merge commit; revert the commits it brought in instead.`);
				const base = parents[0] ?? EMPTY_TREE;
				let changes: FileChange[] = parseNameStatus(await this.git.out(["diff", "-M", "--name-status", base, target])).filter((c) => c.path !== ".gitattributes" && c.from !== ".gitattributes");
				let only: string | null = null;
				if ((args.path ?? "").trim() || (args.name ?? "").trim()) {
					if ((args.path ?? "").trim() && (args.name ?? "").trim()) throw new MemoryError("INVALID_ARGUMENT", "Give either «path» or «name», not both.");
					const wanted = args.path?.trim() ? checkPath(args.path, this.conventions, "note") : null;
					const key = wanted ? null : targetNameOf((args.name as string).trim().replace(/^!?\[\[|\]\]$/g, "").replace(/[#|].*$/, ""));
					const matches = (p: string | undefined) => p !== undefined && /\.md$/i.test(p) && (wanted ? p === wanted : targetNameOf(p) === key);
					changes = changes.filter((c) => matches(c.path) || matches(c.from));
					if (changes.length === 0) throw new MemoryError("NOT_FOUND", `Commit ${short} did not touch «${args.path ?? args.name}».`);
					if (changes.length > 1) throw new MemoryError("INVALID_ARGUMENT", `Several notes in ${short} match «${args.name}»; use «path».`, { paths: changes.map((c) => c.path) });
					only = changes[0]?.path ?? null;
				}
				if (changes.length === 0) throw new MemoryError("NOT_RESTORABLE", `Commit ${short} changed nothing that can be reverted.`);

				const isText = (p: string) => /\.md$/i.test(p) || !p.includes("/");
				const notRestorable = (p: string) =>
					new MemoryError("NOT_RESTORABLE", `«${p}» is a binary attachment; revert cannot bring its old content back. Attach the file again${only ? "" : ", or revert only the note with «path»"}.`, { path: p });
				const conflict = async (p: string, why: string) => {
					const later = (await this.git.out(["log", "--format=%H %s", `${target}..HEAD`, "--", p])).trim().split("\n").filter(Boolean);
					return new MemoryError("REVERT_CONFLICT", `«${p}» ${why} since ${short}; nothing was reverted. Change it by hand instead.`, {
						path: p,
						later_commits: later.map((l) => ({ commit: l.slice(0, 40), message: l.slice(41) })),
					});
				};
				let renamedLater: FileChange[] | null = null;
				/** Whether a path was moved (renamed) by a later commit, as opposed to deleted. */
				const movedSince = async (p: string) => {
					renamedLater ??= parseNameStatus(await this.git.out(["log", "-M", "--diff-filter=R", "--name-status", "--format=", `${target}..HEAD`]));
					return renamedLater.some((r) => r.from === p);
				};
				const writes = new Map<string, string>(); // text, for the checks below
				const raw = new Map<string, Buffer>(); // exact bytes to write instead, for files copied from history unchanged
				/** Old text back on top of the current one, keeping later changes that do not overlap. */
				const restoreText = async (dest: string, p: string, now: string, was: string, old: string) => {
					if (now === was) {
						const bytes = await this.blobBytes(old);
						raw.set(dest, bytes);
						writes.set(dest, bytes.toString("utf8"));
						return;
					}
					const merged = await this.mergeText(await this.blobText(now), await this.blobText(was), await this.blobText(old));
					if (merged === null) throw await conflict(p, "was changed again where this commit changed it");
					writes.set(dest, merged);
				};

				const removes = new Set<string>();
				const renames: { from: string; to: string }[] = [];
				const created = new Set<string>(); // paths that do not exist now and the revert brings back
				const summary: { path: string; change: "restored" | "removed" | "reverted" | "moved_back"; from?: string }[] = [];
				for (const c of changes) {
					const now = await this.blobAt("HEAD", c.path);
					const was = await this.blobAt(target, c.path);
					if (c.status === "A" || c.status === "C") {
						if (now === null) {
							if (await movedSince(c.path)) throw await conflict(c.path, "was moved");
							continue; // already gone
						}
						if (now !== was) throw await conflict(c.path, "was changed");
						removes.add(c.path);
						summary.push({ path: c.path, change: "removed" });
					} else if (c.status === "D") {
						const old = (await this.blobAt(base, c.path)) as string;
						if (now === old) continue; // already back
						if (now !== null) throw await conflict(c.path, "was created again");
						if (!isText(c.path)) throw notRestorable(c.path);
						await restoreText(c.path, c.path, old, old, old);
						created.add(c.path);
						summary.push({ path: c.path, change: "restored" });
					} else if (c.status === "R" && c.from) {
						const old = (await this.blobAt(base, c.from)) as string;
						const nowOld = await this.blobAt("HEAD", c.from);
						if (now === null && nowOld === old) continue; // already moved back
						if (now === null) throw await conflict(c.path, "was moved or deleted");
						if (nowOld !== null) throw await conflict(c.from, "was created again");
						if (isText(c.path) && isText(c.from)) await restoreText(c.from, c.path, now, was as string, old);
						else if (now === was && was === old) renames.push({ from: c.path, to: c.from });
						else throw notRestorable(c.path);
						removes.add(c.path);
						created.add(c.from);
						summary.push({ path: c.from, change: "moved_back", from: c.path });
					} else {
						const old = await this.blobAt(base, c.path);
						if (now === old) continue; // already as it was
						if (now === null || old === null) throw await conflict(c.path, "was deleted");
						if (!isText(c.path)) throw notRestorable(c.path);
						await restoreText(c.path, c.path, now, was as string, old);
						summary.push({ path: c.path, change: "reverted" });
					}
				}

				// The same rules as the other writes: allowed paths (no hidden files, allowed folders), unique names,
				// valid frontmatter, no broken backlinks.
				const touched = [...writes.keys(), ...removes, ...renames.map((r) => r.to)];
				for (const p of new Set([...touched, ...renames.map((r) => r.from)])) checkPath(p, this.conventions, /\.md$/i.test(p) ? "note" : "asset");
				for (const p of touched) await this.assertNoSymlink(p);
				for (const p of created) {
					const key = targetNameOf(p);
					const taken = (/\.md$/i.test(p) ? this.index.notesByName(key).map((n) => n.path) : this.index.assetsByName(key)).filter((t) => t !== p && !removes.has(t));
					if (taken.length) throw new MemoryError("NAME_TAKEN", `A note or file named «${key}» exists now at ${taken[0]}; names must be unique across folders.`, { path: p, existing: taken });
				}
				const kept = new Set([...created].map(targetNameOf));
				const backlinks: { src_path: string; line: number; target: string }[] = [];
				for (const p of removes) {
					const key = targetNameOf(p);
					if (kept.has(key)) continue; // moved back under the same name
					for (const l of this.index.linksIn(p)) {
						if (l.srcPath === p || removes.has(l.srcPath)) continue;
						const after = writes.get(l.srcPath);
						if (after !== undefined && !parseTypedLinks(after).some((x) => x.targetName === key)) continue;
						backlinks.push({ src_path: l.srcPath, line: l.line, target: p });
					}
				}
				if (backlinks.length) {
					throw new MemoryError("HAS_BACKLINKS", `Reverting ${short} would remove notes that other notes link to; fix or remove those links first${only ? "" : ", or revert only one note with «path»"}.`, { backlinks });
				}
				const warnings: Warning[] = [];
				for (const [p, text] of writes) {
					if (!/\.md$/i.test(p)) continue;
					const previous = (await this.exists(p)) ? await this.readText(p) : text;
					warnings.push(...this.validateNote(p, text, previous));
					for (const w of this.linkWarnings(text, p)) {
						if (w.code !== "BROKEN_LINKS") warnings.push({ ...w, path: p });
						else {
							// Links to notes this same revert brings back are not broken.
							const targets = (w.targets as string[]).filter((t) => !kept.has(targetNameOf(t)));
							if (targets.length) warnings.push({ code: "BROKEN_LINKS", message: `Links to notes that do not exist: ${targets.join(", ")}.`, targets, path: p });
						}
					}
				}

				for (const p of removes) await rm(this.abs(p), { force: true });
				for (const r of renames) {
					await mkdir(dirname(this.abs(r.to)), { recursive: true });
					await rename(this.abs(r.from), this.abs(r.to));
				}
				for (const [p, text] of writes) await this.writeText(p, raw.get(p) ?? text);
				const paths = [...new Set([...touched, ...renames.map((r) => r.from)])];
				const main = only ? (summary[0]?.path ?? only) : (summary.find((s) => /\.md$/i.test(s.path) && s.change !== "removed")?.path ?? summary[0]?.path ?? changes[0]?.path ?? "");
				return { paths, result: { path: main, reverted: target, changes: summary }, warnings, contentPath: main, trailers: { Reverts: target } };
			},
		);
	}

	async attach(
		client: ClientIdentity,
		args: { path: string; source: { upload_id?: string; base64?: string }; name?: string; title?: string; description: string; aliases?: string[]; reason: string; confirm_new?: boolean },
	): Promise<WriteResult> {
		if (client.scope !== "write") throw READ_ONLY;
		const uploads = this.opts.uploads;
		if (!uploads) throw new MemoryError("INTERNAL", "Uploads are not configured on this server.");
		const binPath = checkPath(args.path, this.conventions, "asset");
		checkNewFilename(binPath, this.conventions);
		if (!args.source || (!args.source.upload_id && !args.source.base64)) throw new MemoryError("INVALID_ARGUMENT", "«source» needs upload_id or base64.");
		const fileName = binPath.split("/").pop() as string;
		const upload = args.source.upload_id ? await uploads.get(args.source.upload_id) : await uploads.get((await uploads.fromBase64(args.source.base64 as string, fileName, client.id)).id);
		const ext = (fileName.split(".").pop() as string).toLowerCase();
		// Extraction runs before taking the write lock: it can be slow and touches only the upload.
		const extraction: Extraction = await extractAttachment(upload.file, ext, { pdftotext: this.opts.pdftotext, ocr: this.opts.ocr });
		const result = await this.mutate(client, "attach", args.reason, async () => {
			if (!this.lfs) throw new MemoryError("LFS_UNAVAILABLE", "git-lfs is not installed on the server.");
			const dir = dirOf(binPath);
			const companionName = (args.name ?? fileName.replace(/\.[^.]+$/, "")).replace(/\.md$/i, "");
			const companion = joinPath(dir, `${companionName}.md`);
			checkPath(companion, this.conventions, "note");
			checkNewFilename(companion, this.conventions);
			await this.assertNoSymlink(binPath);
			await this.assertNoSymlink(companion);
			if (typeof args.description !== "string" || !args.description.trim()) throw new MemoryError("INVALID_ARGUMENT", "«description» is required.");
			if (await this.exists(binPath)) throw new MemoryError("ALREADY_EXISTS", `«${binPath}» already exists.`, { path: binPath });
			if (await this.exists(companion)) throw new MemoryError("ALREADY_EXISTS", `«${companion}» already exists.`, { path: companion });
			const takenNote = this.index.notesByName(companionName);
			if (takenNote.length) throw new MemoryError("NAME_TAKEN", `A note named «${companionName}» already exists at ${takenNote[0]?.path}.`, { existing: takenNote.map((t) => t.path) });
			const takenAsset = this.index.assetsByName(fileName);
			if (takenAsset.length) throw new MemoryError("NAME_TAKEN", `A file named «${fileName}» already exists at ${takenAsset[0]}.`, { existing: takenAsset });
			const title = args.title?.trim() || fileName;
			const aliases = Array.isArray(args.aliases) ? args.aliases.filter((a) => typeof a === "string" && a.trim()) : [];
			if (!args.confirm_new) {
				const candidates = this.duplicateCandidates([companionName.replace(/-/g, " "), title, ...aliases]);
				if (candidates.length) throw new MemoryError("DUPLICATE_CANDIDATES", "Some existing notes look like the same thing. If this really is new, call attach again with confirm_new: true.", { candidates });
			}
			// LFS rule for this extension, in the same commit.
			const paths = [binPath, companion];
			const attr = await this.git.out(["check-attr", "filter", "--", binPath]);
			if (!/filter: lfs\s*$/.test(attr.trim())) {
				const current = (await this.exists(".gitattributes")) ? await this.readText(".gitattributes") : "";
				await this.writeText(".gitattributes", `${current}${current && !current.endsWith("\n") ? "\n" : ""}*.${ext} filter=lfs diff=lfs merge=lfs -text\n`);
				paths.push(".gitattributes");
			}
			await mkdir(dirname(this.abs(binPath)), { recursive: true });
			try {
				await rename(upload.file, this.abs(binPath));
			} catch {
				await copyFile(upload.file, this.abs(binPath));
			}
			const fm: Record<string, unknown> = { name: title, description: args.description.replace(/\s+/g, " ").trim(), aliases, attachment: fileName, extracted_with: extraction.method };
			let body = `# ${title}\n\n![[${fileName}]]\n`;
			if (extraction.ocr) body += `\n> ${this.conventions.attachments.ocrNotice.replace("{languages}", extraction.ocr.languages)}\n`;
			if (extraction.image && extraction.pages.length === 1) body += `\n${extraction.pages[0]?.text}\n`;
			else for (const page of extraction.pages) body += `\n## ${this.conventions.attachments.pageHeading.replace("{n}", String(page.number))}\n\n${page.text}\n`;
			const content = `---\n${stringifyYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
			this.validateNote(companion, content);
			await this.writeText(companion, content);
			const warnings: Warning[] = [];
			if (extraction.method === "none") warnings.push({ code: "EXTRACTION_EMPTY", message: `No text was extracted: ${extraction.reason ?? "unknown reason"}.` });
			const { skippedPages = 0, failedPages = [] } = extraction.ocr ?? {};
			if (skippedPages || failedPages.length) {
				const parts = [skippedPages ? `the last ${skippedPages} of ${extraction.pageCount} pages were not OCR'd (page limit)` : "", failedPages.length ? `OCR failed on page(s) ${failedPages.join(", ")}` : ""].filter(Boolean);
				warnings.push({ code: "EXTRACTION_PARTIAL", message: `Only part of the text was extracted: ${parts.join("; ")}.`, skipped_pages: skippedPages, failed_pages: failedPages });
			}
			return { paths, result: { path: companion, attachment: binPath, pages: extraction.pages.length, extracted_with: extraction.method }, warnings, contentPath: companion };
		});
		await uploads.remove(upload.meta.id).catch(() => undefined);
		return result;
	}
}

