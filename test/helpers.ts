import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Git } from "../src/git.js";
import { type ClientIdentity, MemoryService, type MemoryOptions } from "../src/memory.js";
import { UploadStore } from "../src/uploads.js";

export const writer: ClientIdentity = { id: "test-writer", name: "Test Writer", scope: "write" };
export const reader: ClientIdentity = { id: "test-reader", name: "Test Reader", scope: "read" };

export async function tempDir(prefix = "mm-"): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export function note(name: string, description: string, body = "", extra = ""): string {
	return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n\n${body}\n`;
}

/** A bare repo playing Forgejo, seeded with files in one initial commit. */
export async function seedRemote(root: string, files: Record<string, string>): Promise<string> {
	const bare = join(root, "remote.git");
	await new Git(root).run(["init", "-q", "--bare", "-b", "main", bare]);
	const seed = join(root, "seed");
	await mkdir(seed, { recursive: true });
	const git = new Git(seed);
	await git.run(["init", "-q", "-b", "main"]);
	await git.run(["config", "user.name", "Seeder"]);
	await git.run(["config", "user.email", "seed@example.com"]);
	await git.run(["config", "core.autocrlf", "false"]);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(seed, path)), { recursive: true });
		await writeFile(join(seed, path), content);
	}
	if (Object.keys(files).length) {
		await git.run(["add", "-A"]);
		await git.run(["commit", "-q", "-m", "seed"]);
		await git.run(["push", "-q", bare, "main"]);
	}
	return bare;
}

/** A second clone of the remote, to act as "someone else" pushing. */
export async function otherClone(root: string, bare: string): Promise<{ dir: string; git: Git; write: (path: string, content: string) => Promise<void>; commitPush: (msg: string) => Promise<void> }> {
	const dir = join(root, `other-${Math.random().toString(36).slice(2, 8)}`);
	await new Git(root).run(["clone", "-q", bare, dir]);
	const git = new Git(dir);
	await git.run(["config", "user.name", "Someone"]);
	await git.run(["config", "user.email", "someone@example.com"]);
	await git.run(["config", "core.autocrlf", "false"]);
	return {
		dir,
		git,
		write: async (path, content) => {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), content);
		},
		commitPush: async (msg) => {
			await git.run(["add", "-A"]);
			await git.run(["commit", "-q", "-m", msg]);
			await git.run(["pull", "-q", "--rebase", "origin", "main"]);
			await git.run(["push", "-q", "origin", "main"]);
		},
	};
}

export const CONVENTIONS = `[folders]
allowed = ["yo", "personas", "temas", "proyectos", "archivo"]
archive = "archivo"
index_full = ["yo"]

[notes]
superseded_field = "sustituida_por"

[attachments]
page_heading = "Página {n}"
`;

export async function makeMemory(
	files: Record<string, string> = {},
	opts: Partial<MemoryOptions> & { noRemote?: boolean } = {},
): Promise<{ root: string; memory: MemoryService; bare: string | null; cleanup: () => Promise<void> }> {
	const root = await tempDir();
	const bare = opts.noRemote ? null : await seedRemote(root, { "memory.toml": CONVENTIONS, ...files });
	const uploads = new UploadStore(join(root, "data", "uploads"));
	await uploads.init();
	const memory = new MemoryService({
		repoDir: join(root, "data", "repo"),
		indexPath: join(root, "data", "index.sqlite"),
		remote: bare ? { url: bare } : null,
		uploads,
		pushRetry: { initialMs: 50, maxMs: 200 },
		...opts,
	});
	await memory.start();
	const env = {
		root,
		memory,
		bare,
		cleanup: async () => {
			await memory.stop();
			if (env.memory !== memory) await env.memory.stop();
			await rm(root, { recursive: true, force: true, maxRetries: 5 });
		},
	};
	return env;
}
