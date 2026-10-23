import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryError } from "../src/errors.js";
import { Git } from "../src/git.js";
import { MemoryService } from "../src/memory.js";
import { GitHubStore } from "../src/store-github.js";
import { readTarGz } from "../src/tar.js";
import { type FakeGitHub, fakeGitHub } from "./fake-github.js";
import { CONVENTIONS, note, otherClone, seedRemote, tempDir, writer } from "./helpers.js";

const SEED = {
	"AGENTS.md": "# Normas\n\nEnlaza con [[nombre]].\n",
	"yo/perfil.md": note("Perfil", "Quién es Alex", "Estudia en la [[universidad]].", "aliases: [yo, Alex]\n"),
	"temas/universidad.md": note("Universidad", "Carrera y asignaturas", "## Este curso\n\nCinco asignaturas; la peor es Estadística.\n\n## Exámenes\n\nEn enero.\n"),
	"temas/piso.md": note("Piso", "El piso y su hipoteca", "Hipotecas y préstamos. Ver [[universidad]]."),
};

type Env = { root: string; bare: string; gh: FakeGitHub; memory: MemoryService; open: () => Promise<MemoryService>; cleanup: () => Promise<void> };
let env: Env | null = null;
afterEach(async () => {
	await env?.cleanup();
	env = null;
});

async function make(files: Record<string, string> = SEED): Promise<Env> {
	const root = await tempDir("mm-gh-");
	const bare = await seedRemote(root, { "memory.toml": CONVENTIONS, ...files });
	const gh = await fakeGitHub(bare);
	const opened: MemoryService[] = [];
	const open = async () => {
		const n = opened.length;
		const store = new GitHubStore({ owner: "alex", repo: "memoria", branch: "main", token: "t0ken", apiUrl: gh.url, worktree: join(root, `work-${n}`) });
		const m = new MemoryService({ repoDir: join(root, "unused"), indexPath: join(root, `index-${n}.sqlite`), store });
		await m.start();
		opened.push(m);
		return m;
	};
	const memory = await open();
	return {
		root,
		bare,
		gh,
		memory,
		open,
		cleanup: async () => {
			for (const m of opened) await m.stop();
			await gh.close();
			await rm(root, { recursive: true, force: true, maxRetries: 5 });
		},
	};
}

async function expectCode(p: Promise<unknown>, code: string): Promise<MemoryError> {
	try {
		await p;
	} catch (error) {
		expect(error).toBeInstanceOf(MemoryError);
		expect((error as MemoryError).code).toBe(code);
		return error as MemoryError;
	}
	throw new Error(`expected ${code}`);
}

const remoteGit = (e: Env) => new Git(e.bare);

describe("tar reader", () => {
	it("reads a git archive tarball, stripping the top folder", async () => {
		const root = await tempDir("mm-tar-");
		try {
			const long = `temas/${"una-nota-con-un-nombre-muy-largo-".repeat(5)}fin.md`;
			const bare = await seedRemote(root, { "a.md": "A\n", [long]: "largo\n", "dir/b.bin": "\u0000\u0001binario" });
			const { gzipSync } = await import("node:zlib");
			const tgz = gzipSync(await new Git(bare).bytes(["archive", "--format=tar", "--prefix=alex-memoria-abc/", "main"]));
			const files = readTarGz(tgz, 1);
			expect(files.map((f) => f.path).sort()).toEqual(["a.md", "dir/b.bin", long].sort());
			expect(files.find((f) => f.path === long)?.data.toString()).toBe("largo\n");
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5 });
		}
	});
});

describe("GitHubStore", () => {
	it("downloads the repo, indexes it and takes dates from GitHub", async () => {
		env = await make();
		const r = env.memory.search({ query: "hipoteca" });
		expect(r.hits[0]?.path).toBe("temas/piso.md");
		const listed = env.memory.list({ folder: "temas" }) as { notes: { path: string; updated_by: string }[] };
		expect(listed.notes.map((n) => n.updated_by)).toEqual(["Seeder", "Seeder"]);
		expect(await env.memory.instructions()).toContain("Enlaza con [[nombre]]");
	});

	it("commits each write to GitHub with the client as author and its trailers", async () => {
		env = await make();
		const created = await env.memory.create(writer, { path: "temas/coche.md", content: note("Coche", "El coche de Alex", "Un Seat."), reason: "Apunto el coche" });
		expect(created.commit).toMatch(/^[0-9a-f]{40}$/);
		const log = await remoteGit(env).out(["log", "-1", "--format=%an <%ae>|%B", "main"]);
		expect(log).toContain("Test Writer <test-writer@my-memory.invalid>");
		expect(log).toContain("Apunto el coche");
		expect(log).toContain("Tool: create");
		expect(await remoteGit(env).out(["show", "main:temas/coche.md"])).toContain("Un Seat.");

		const read = await env.memory.read({ name: "coche" });
		expect(read.hash).toBe(created.hash);
		const edited = await env.memory.edit(writer, { name: "coche", edits: [{ old_string: "Un Seat.", new_string: "Un Seat Ibiza." }], reason: "Modelo", hash: read.hash });
		expect(edited.commit).not.toBe(created.commit);
		const old = await env.memory.read({ name: "coche", revision: created.commit as string });
		expect(old.content).toContain("Un Seat.");
		expect(old.content).not.toContain("Ibiza");
		expect((await env.memory.read({ name: "coche" })).content).toContain("Ibiza");
	});

	it("moves a note and rewrites its backlinks in one commit; deletes", async () => {
		env = await make();
		const hash = (await env.memory.read({ name: "universidad" })).hash;
		const moved = await env.memory.move(writer, { from: "universidad", to: "temas/carrera.md", hash, reason: "Renombro" });
		expect(moved.links_rewritten).toBe(2);
		const files = (await remoteGit(env).out(["show", "--name-status", "--format=", "main"])).trim().split("\n");
		expect(files.length).toBe(4); // the move (delete + add) and the two notes that linked to it
		expect(await remoteGit(env).out(["show", "main:temas/piso.md"])).toContain("[[carrera]]");
		expect(env.memory.search({ query: "estadistica" }).hits[0]?.path).toBe("temas/carrera.md");

		const piso = await env.memory.read({ name: "piso" });
		await expectCode(env.memory.delete(writer, { name: "carrera", hash: (await env.memory.read({ name: "carrera" })).hash, reason: "x" }), "HAS_BACKLINKS");
		await env.memory.delete(writer, { name: "piso", hash: piso.hash, reason: "Ya no está" });
		expect((await remoteGit(env).run(["cat-file", "-e", "main:temas/piso.md"], { allowFail: true })).code).not.toBe(0);
	});

	it("history, recent and revert (with a later change that does not overlap)", async () => {
		env = await make();
		const r1 = await env.memory.read({ name: "universidad" });
		const first = await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "En enero.", new_string: "En enero y junio." }], reason: "Convocatorias" });
		await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco asignaturas", new_string: "Seis asignaturas" }], reason: "Una más" });
		const history = await env.memory.history({ name: "universidad" });
		expect(history.commits.map((c) => c.message)).toEqual(["Una más", "Convocatorias", "seed"]);
		expect(history.commits[0]?.trailers.Client).toBe("test-writer");

		const recent = await env.memory.recent({ limit: 2 });
		expect(recent.commits.map((c) => c.reason)).toEqual(["Una más", "Convocatorias"]);
		expect(recent.commits[0]?.notes).toEqual([{ path: "temas/universidad.md", name: "universidad", change: "modified" }]);

		const reverted = await env.memory.revert(writer, { commit: first.commit as string, reason: "Deshago lo de junio" });
		const now = (await env.memory.read({ name: "universidad" })).content;
		expect(now).toContain("En enero.");
		expect(now).not.toContain("junio");
		expect(now).toContain("Seis asignaturas"); // the later change stays
		expect(reverted.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(r1.hash).not.toBe((await env.memory.read({ name: "universidad" })).hash);
	});

	it("brings in someone else's change to another file and keeps both", async () => {
		env = await make();
		const other = await otherClone(env.root, env.bare);
		await other.write("temas/viajes.md", note("Viajes", "Viajes de Alex", "A Lisboa."));
		await other.commitPush("Otro agente apunta los viajes");
		const r = await env.memory.create(writer, { path: "temas/coche.md", content: note("Coche", "El coche", "Un Seat."), reason: "Coche" });
		expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
		const tree = await remoteGit(env).out(["ls-tree", "-r", "--name-only", "main"]);
		expect(tree).toContain("temas/viajes.md");
		expect(tree).toContain("temas/coche.md");
		expect(env.memory.search({ query: "lisboa" }).hits[0]?.path).toBe("temas/viajes.md");
	});

	it("on a collision with someone else's change to the same note, the remote wins", async () => {
		env = await make();
		const hash = (await env.memory.read({ name: "piso" })).hash;
		const other = await otherClone(env.root, env.bare);
		await other.write("temas/piso.md", note("Piso", "El piso y su hipoteca", "Vendido."));
		await other.commitPush("Otro agente: vendido");
		const err = await expectCode(env.memory.write(writer, { name: "piso", content: note("Piso", "El piso y su hipoteca", "Alquilado."), hash, reason: "Alquilado" }), "REMOTE_CONFLICT");
		expect(err.details?.content).toContain("Vendido.");
		expect((await env.memory.read({ name: "piso" })).content).toContain("Vendido.");
		expect(await remoteGit(env).out(["show", "main:temas/piso.md"])).toContain("Vendido.");
	});

	it("picks up remote changes on sync, and a cold start sees everything", async () => {
		env = await make();
		const other = await otherClone(env.root, env.bare);
		await other.write("temas/viajes.md", note("Viajes", "Viajes de Alex", "A Lisboa."));
		await other.commitPush("viajes");
		env.memory.requestSync("test");
		await new Promise((ok) => setTimeout(ok, 400));
		await env.memory.idle();
		expect(env.memory.search({ query: "lisboa" }).hits[0]?.path).toBe("temas/viajes.md");

		await env.memory.create(writer, { path: "temas/coche.md", content: note("Coche", "El coche", "Un Seat."), reason: "Coche" });
		const second = await env.open();
		expect(second.search({ query: "seat" }).hits[0]?.path).toBe("temas/coche.md");
		expect(second.search({ query: "lisboa" }).hits[0]?.path).toBe("temas/viajes.md");
	});

	it("has no attachments", async () => {
		env = await make();
		const err = await expectCode(env.memory.attach(writer, { path: "temas/a.pdf", source: { base64: "JVBERi0=" }, description: "x", reason: "x" }), "INTERNAL");
		expect(err.message).toContain("Uploads");
	});
});
