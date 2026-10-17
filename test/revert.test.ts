import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryError } from "../src/errors.js";
import { Git } from "../src/git.js";
import { makeMemory, note, otherClone, reader, writer } from "./helpers.js";

const SEED = {
	"yo/perfil.md": note("Perfil", "Quién es Alex", "Estudia en la [[universidad]]."),
	"temas/universidad.md": note("Universidad", "Carrera y asignaturas", "## Este curso\n\nCinco asignaturas.\n\n## Exámenes\n\nEn enero.\n"),
	"temas/piso.md": note("Piso", "El piso de Oviedo", "Hipoteca."),
};

let env: Awaited<ReturnType<typeof makeMemory>> | null = null;
afterEach(async () => {
	await env?.cleanup();
	env = null;
});

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

const repo = () => join(env!.root, "data/repo");
const file = (path: string) => readFile(join(repo(), path), "utf8");

describe("recent", () => {
	it("lists commits across the repo with their files, newest first, and pages", async () => {
		env = await makeMemory(SEED);
		const first = await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], reason: "Seis asignaturas" });
		await env.memory.create({ ...writer, session: "s-1" }, { path: "personas/sara.md", content: note("Sara", "Amiga", "Ver [[perfil]]."), reason: "Nueva persona" });
		const piso = await env.memory.read({ name: "piso" });
		await env.memory.move(writer, { from: "temas/piso.md", to: "archivo/piso.md", hash: piso.hash, reason: "Archivar el piso" });

		const r = await env.memory.recent({});
		expect(r.commits.map((c) => c.message)).toEqual(["Archivar el piso", "Nueva persona", "Seis asignaturas", "seed"]);
		expect(r.commits[0]).toMatchObject({ author: "Test Writer", trailers: { Client: "test-writer", Tool: "move" }, files: [{ status: "renamed", from: "temas/piso.md", path: "archivo/piso.md" }] });
		expect(r.commits[1]).toMatchObject({ trailers: { Session: "s-1" }, files: [{ status: "added", path: "personas/sara.md" }] });
		expect(r.next_cursor).toBeNull();

		const after = await env.memory.recent({ after: first.commit as string });
		expect(after.commits.map((c) => c.message)).toEqual(["Archivar el piso", "Nueva persona"]);

		const page1 = await env.memory.recent({ limit: 2 });
		expect(page1.commits).toHaveLength(2);
		const page2 = await env.memory.recent({ limit: 2, cursor: page1.next_cursor as string });
		expect(page2.commits.map((c) => c.message)).toEqual(["Seis asignaturas", "seed"]);
		expect(page2.next_cursor).toBeNull();

		const personas = await env.memory.recent({ folder: "personas/" });
		expect(personas.commits.map((c) => c.message)).toEqual(["Nueva persona"]);
		expect((await env.memory.recent({ since: "2999-01-01" })).commits).toEqual([]);
		expect((await env.memory.recent({ since: "2000-01-01" })).commits).toHaveLength(4);

		await expectCode(env.memory.recent({ since: "ayer" }), "INVALID_ARGUMENT");
		await expectCode(env.memory.recent({ after: "zzzz" }), "INVALID_REVISION");
		await expectCode(env.memory.recent({ after: "deadbeef" }), "INVALID_REVISION");
		await expectCode(env.memory.recent({ folder: "../x" }), "INVALID_ARGUMENT");
		await expectCode(env.memory.recent({ cursor: "-1" }), "INVALID_ARGUMENT");
	});
});

describe("revert", () => {
	it("undoes an edit with a new commit, reindexes and pushes", async () => {
		env = await makeMemory(SEED);
		const edited = await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco asignaturas.", new_string: "Seis asignaturas, una de Topología." }], reason: "Cambio de asignaturas" });
		expect(env.memory.search({ query: "topologia" }).hits).toHaveLength(1);

		const r = await env.memory.revert({ ...writer, session: "s-9" }, { commit: (edited.commit as string).slice(0, 10), reason: "Deshacer el cambio de asignaturas" });
		expect(r).toMatchObject({ path: "temas/universidad.md", paths: ["temas/universidad.md"], reverted: { commit: edited.commit, message: "Cambio de asignaturas" }, warnings: [] });
		expect(await file("temas/universidad.md")).toContain("Cinco asignaturas.");
		expect(r.hash).toBe((await env.memory.read({ name: "universidad" })).hash);
		expect(env.memory.search({ query: "topologia" }).hits).toHaveLength(0);

		const remote = await new Git(env.root).out(["--git-dir", env.bare as string, "log", "-1", "--format=%an|%B"]);
		expect(remote).toContain("Test Writer|Deshacer el cambio de asignaturas");
		expect(remote).toContain(`Reverts: ${edited.commit}`);
		expect(remote).toContain("Tool: revert");
		expect(remote).toContain("Session: s-9");

		const again = await env.memory.revert(writer, { commit: edited.commit as string, reason: "Otra vez" });
		expect(again.warnings.map((w) => w.code)).toContain("NO_CHANGES");
	});

	it("undoes a create and a delete", async () => {
		env = await makeMemory(SEED);
		const created = await env.memory.create(writer, { path: "personas/sara.md", content: note("Sara", "Amiga", "Ver [[perfil]]."), reason: "Nueva persona" });
		const undone = await env.memory.revert(writer, { commit: created.commit as string, reason: "No era una persona" });
		expect(undone).toMatchObject({ paths: ["personas/sara.md"], hash: null });
		await expectCode(env.memory.read({ name: "sara" }), "NOT_FOUND");
		expect(((await env.memory.links({ name: "perfil", direction: "in" })) as { in: unknown[] }).in).toHaveLength(0);

		const piso = await env.memory.read({ name: "piso" });
		const deleted = await env.memory.delete(writer, { name: "piso", hash: piso.hash, reason: "Fuera" });
		const restored = await env.memory.revert(writer, { commit: deleted.commit as string, reason: "Recuperar el piso" });
		expect(restored.path).toBe("temas/piso.md");
		expect((await env.memory.read({ name: "piso" })).hash).toBe(piso.hash);
	});

	it("undoes a move, bringing the incoming links back", async () => {
		env = await makeMemory(SEED);
		const uni = await env.memory.read({ name: "universidad" });
		const moved = await env.memory.move(writer, { from: "temas/universidad.md", to: "temas/carrera.md", hash: uni.hash, reason: "Renombrar" });
		expect(await file("yo/perfil.md")).toContain("[[carrera]]");
		const r = await env.memory.revert(writer, { commit: moved.commit as string, reason: "Volver al nombre" });
		expect(r.warnings).toEqual([]);
		expect(await file("yo/perfil.md")).toContain("[[universidad]]");
		expect((await env.memory.read({ name: "universidad" })).hash).toBe(uni.hash);
		expect(env.memory.index.brokenLinks()).toEqual([]);
	});

	it("reports conflicts with later commits and leaves everything as it was", async () => {
		env = await makeMemory(SEED);
		const a = await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], reason: "A" });
		const b = await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Seis", new_string: "Siete" }], reason: "B" });
		const head = await new Git(repo()).head();
		const e = await expectCode(env.memory.revert(writer, { commit: a.commit as string, reason: "Deshacer A" }), "REVERT_CONFLICT");
		expect(e.details).toMatchObject({ paths: ["temas/universidad.md"], later_commits: [{ commit: b.commit, message: "B" }] });
		expect(await new Git(repo()).head()).toBe(head);
		expect(await new Git(repo()).isClean()).toBe(true);
		expect(await file("temas/universidad.md")).toContain("Siete");

		// Newest first works, and the memory keeps accepting writes.
		await env.memory.revert(writer, { commit: b.commit as string, reason: "Deshacer B" });
		await env.memory.revert(writer, { commit: a.commit as string, reason: "Deshacer A" });
		expect(await file("temas/universidad.md")).toContain("Cinco asignaturas.");
	});

	it("keeps names unique and refuses to remove linked notes", async () => {
		env = await makeMemory(SEED);
		const created = await env.memory.create(writer, { path: "personas/sara.md", content: note("Sara", "Amiga"), reason: "Nueva persona" });
		await env.memory.edit(writer, { name: "perfil", edits: [{ old_string: "Estudia", new_string: "Amiga de [[sara]]. Estudia" }], reason: "Enlazar" });
		const e = await expectCode(env.memory.revert(writer, { commit: created.commit as string, reason: "x" }), "HAS_BACKLINKS");
		expect(e.details.backlinks).toMatchObject([{ src_path: "yo/perfil.md", target: "personas/sara.md" }]);
		expect(await new Git(repo()).isClean()).toBe(true);

		const piso = await env.memory.read({ name: "piso" });
		const deleted = await env.memory.delete(writer, { name: "piso", hash: piso.hash, reason: "Fuera" });
		await env.memory.create(writer, { path: "proyectos/piso.md", content: note("Piso nuevo", "Otro piso"), reason: "Otro", confirm_new: true });
		await expectCode(env.memory.revert(writer, { commit: deleted.commit as string, reason: "x" }), "NAME_TAKEN");
	});

	it("validates the commit and the client", async () => {
		env = await makeMemory(SEED);
		const seed = (await env.memory.recent({})).commits[0]?.commit as string;
		await expectCode(env.memory.revert(writer, { commit: seed, reason: "x" }), "INVALID_ARGUMENT");
		await expectCode(env.memory.revert(writer, { commit: "HEAD~1", reason: "x" }), "INVALID_REVISION");
		await expectCode(env.memory.revert(writer, { commit: "abcdef12", reason: "x" }), "INVALID_REVISION");
		await expectCode(env.memory.revert(reader, { commit: seed, reason: "x" }), "FORBIDDEN");
		await expectCode(env.memory.revert(writer, { commit: seed, reason: " " }), "INVALID_ARGUMENT");
	});

	it("reverts a commit pushed from elsewhere", async () => {
		env = await makeMemory(SEED);
		const other = await otherClone(env.root, env.bare as string);
		await other.write("temas/piso.md", note("Piso", "El piso de Oviedo", "Hipoteca y alquiler."));
		await other.commitPush("Editado a mano");
		env.memory.requestSync("test");
		await new Promise((r) => setTimeout(r, 500));
		await env.memory.idle();
		const last = (await env.memory.recent({ limit: 1 })).commits[0];
		expect(last).toMatchObject({ message: "Editado a mano", author: "Someone" });
		await env.memory.revert(writer, { commit: last?.commit as string, reason: "Quitar lo del alquiler" });
		expect(await file("temas/piso.md")).not.toContain("alquiler");
	});
});
