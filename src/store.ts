import type { FileChange } from "./util.js";

/** Dates and authors of a file from its history: the last commit that touched it and, when known, the first. */
export interface FileDates {
	updatedAt: string;
	updatedBy: string;
	createdAt?: string;
	createdBy?: string;
}

/** One commit as the history tools need it. `files` only from `log`. */
export interface LogEntry {
	commit: string;
	date: string;
	author: string;
	email: string;
	/** The subject: the reason the client gave. */
	message: string;
	trailers: Record<string, string>;
	files?: FileChange[];
}

export type FetchResult = { status: "ok" } | { status: "empty" } | { status: "unreachable"; error: string };
export type PushResult = { status: "ok" } | { status: "rejected" } | { status: "failed"; error: string };

/** The author of a commit: the client that made the write. */
export interface Author {
	name: string;
	email: string;
}

/**
 * A commit could not be published because someone else changed the same files at the same time. The memory then
 * goes back to the remote's version (the remote wins) and the client is told to redo its change.
 */
export class StoreConflictError extends Error {
	constructor(readonly lost: string[]) {
		super("The remote changed the same files at the same time.");
	}
}

/**
 * Where the notes live and how their history is kept. The memory always works on a local folder with the files of
 * HEAD (`worktree`): it reads them, applies each write to them and then asks the store to commit the paths it
 * touched. Two stores:
 *
 * - `GitStore` (store-git.ts): a git working clone on disk, pushed to an optional remote. For a server of your own.
 * - `GitHubStore` (store-github.ts): a GitHub repository through its API, with the worktree in a temporary folder.
 *   For serverless hosts such as Vercel, where there is no persistent disk and no git binary.
 */
export interface NoteStore {
	/** The local folder with the files of HEAD. */
	readonly worktree: string;
	/** Whether the store can keep binary attachments (git LFS). */
	readonly supportsAttachments: boolean;

	/** Prepares the worktree (clone, init or download). Returns the paths that had uncommitted changes, if any. */
	init(): Promise<{ dirty: string[] }>;
	head(): Promise<string | null>;
	hasCommit(rev: string): Promise<boolean>;
	/** Tracked files at HEAD. */
	listFiles(): Promise<string[]>;
	/**
	 * Dates and authors per path. With `from`, only the commits in from..to; with `latestOnly`, only the newest commit
	 * that touched each path.
	 */
	commitDates(range: { to: string; from?: string | null; latestOnly?: boolean }, paths?: string[]): Promise<Map<string, FileDates>>;
	/** Files that changed between two commits, without rename detection (a rename is a delete and an add). */
	changedFiles(from: string, to: string): Promise<{ status: string; path: string }[]>;
	/** Puts the worktree back to `head` (or empty), dropping any change that was not committed. */
	restore(head: string | null): Promise<void>;
	/**
	 * Commits the given paths as they are in the worktree. Null when nothing changed. A store that publishes as it
	 * commits (GitHub) may first bring in remote changes to other files, and throws StoreConflictError when the remote
	 * changed the same files.
	 */
	commit(paths: string[], message: string, author: Author): Promise<string | null>;

	// ── remote ───────────────────────────────────────────────────────────────
	/** Whether there is a remote to fetch from and push to. */
	readonly hasRemote: boolean;
	fetch(): Promise<FetchResult>;
	/** The remote's head as last fetched, or null. */
	remoteHead(): Promise<string | null>;
	isAncestor(a: string, b: string): Promise<boolean>;
	/** Moves HEAD and the worktree to `rev`: a fast-forward, or (`hard`) dropping the local commits. */
	moveTo(rev: string, opts?: { hard?: boolean }): Promise<void>;
	/** Rebases the local commits on top of `rev`. False (and nothing changed) on a conflict. */
	rebase(rev: string): Promise<boolean>;
	/** Commits in a..b, as `<hash> <subject>`. */
	commitsBetween(a: string, b: string): Promise<string[]>;
	push(): Promise<PushResult>;

	// ── history ──────────────────────────────────────────────────────────────
	/** A file's text at a revision, or null when it does not exist there. */
	show(rev: string, path: string): Promise<string | null>;
	/** The commits that touched a file, newest first, following renames when the store can. */
	fileLog(path: string, limit: number): Promise<LogEntry[]>;
	/** The latest commits of the branch with the files each one touched (renames detected). */
	log(opts: { limit: number; skip: number; since?: string | null; folder?: string | null }): Promise<LogEntry[]>;

	// ── revert ───────────────────────────────────────────────────────────────
	/** The full hash of an existing commit, or null. */
	resolveCommit(rev: string): Promise<string | null>;
	parents(commit: string): Promise<string[]>;
	/** What a commit changed against `base` (a commit, or EMPTY_TREE), with renames. */
	diff(base: string, target: string): Promise<FileChange[]>;
	/** The blob id of a file at a revision, or null. */
	blobAt(rev: string, path: string): Promise<string | null>;
	blobText(id: string): Promise<string>;
	blobBytes(id: string): Promise<Buffer>;
	/** Three-way merge of text: the result, or null when the changes overlap. */
	mergeText(ours: string, base: string, theirs: string): Promise<string | null>;
	/** Commits after `target` (up to HEAD) that touched `path`, as `<hash> <subject>`. */
	commitsTouching(target: string, path: string): Promise<string[]>;
	/** Renames made by the commits after `target` (up to HEAD). */
	renamesSince(target: string): Promise<FileChange[]>;

	// ── attachments ──────────────────────────────────────────────────────────
	/** Whether a path is already stored with git LFS. */
	isLfsTracked(path: string): Promise<boolean>;
}

/** git's empty tree: the "parent" of a root commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Trailers (`Key: value` lines) of a commit message's trailer block. */
export function parseTrailers(text: string): Record<string, string> {
	const trailers: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const m = /^([\w-]+):\s*(.*)$/.exec(line.trim());
		if (m) trailers[m[1] as string] = m[2] as string;
	}
	return trailers;
}
