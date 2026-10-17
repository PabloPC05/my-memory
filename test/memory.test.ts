import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryError } from "../src/errors.js";
import { Git } from "../src/git.js";
import { MemoryService } from "../src/memory.js";
import { SearchIndex } from "../src/search-index.js";
import { CONVENTIONS, makeMemory, note, otherClone, reader, writer } from "./helpers.js";

const SEED = {
	"AGENTS.md": "# Normas\n\nEnlaza con [[nombre]].\n",
	"yo/perfil.md": note("Perfil", "Quién es Alex", "Estudia en la [[universidad]]. Vive en [[piso-de-oviedo]].", "aliases: [yo, Alex]\n"),
	"temas/universidad.md": note("Universidad", "Carrera y asignaturas", "## Este curso\n\nCinco asignaturas; la peor es Estadística.\n\n## Exámenes\n\nEn enero.\n"),
	"temas/piso-de-oviedo.md": note("Piso de Oviedo", "El piso de Oviedo y su hipoteca", "Hipotecas y préstamos. Ver [[universidad#Exámenes|exámenes]]."),
	"archivo/viejo.md": note("Viejo", "Nota archivada", "hipoteca antigua", 'sustituida_por: "[[piso-de-oviedo]]"\n'),
};

let env: Awaited<ReturnType<typeof makeMemory>> | null = null;
afterEach(async () => {
	await env?.cleanup();
	env = null;
});

async function expectCode(p: Promise<unknown> | (() => unknown), code: string): Promise<MemoryError> {
	try {
		await (typeof p === "function" ? p() : p);
	} catch (error) {
		expect(error).toBeInstanceOf(MemoryError);
		expect((error as MemoryError).code).toBe(code);
		return error as MemoryError;
	}
	throw new Error(`expected ${code}`);
}

describe("reading", () => {
	it("indexes the repo and lists the short index", async () => {
		env = await makeMemory(SEED);
		const { index } = env.memory.list({}) as { index: ReturnType<MemoryService["shortIndex"]> };
		expect(index.full).toEqual([{ folder: "yo", notes: [{ path: "yo/perfil.md", name: "perfil", title: "Perfil", description: "Quién es Alex", aliases: ["yo", "Alex"] }] }]);
		expect(index.folders).toEqual([{ folder: "temas", count: 2, names: ["piso-de-oviedo", "universidad"], more: 0 }]);
		const instructions = await env.memory.instructions();
		expect(instructions).toContain("Enlaza con [[nombre]]");
		expect(instructions).toContain("[[perfil]] — Perfil: Quién es Alex");
		expect(instructions).toContain("archivo/ is archived");
	});

	it("lists a folder with dates and authors from git", async () => {
		env = await makeMemory(SEED);
		const r = env.memory.list({ folder: "temas" }) as { notes: { path: string; updated_by: string; updated_at: string }[] };
		expect(r.notes.map((n) => n.path)).toEqual(["temas/piso-de-oviedo.md", "temas/universidad.md"]);
		expect(r.notes[0]?.updated_by).toBe("Seeder");
		expect(r.notes[0]?.updated_at).toMatch(/^\d{4}-/);
		await expectCode(() => env!.memory.list({ folder: "nada" }), "NOT_FOUND");
		const archived = env.memory.list({ folder: "archivo" }) as { notes: { path: string; superseded_by: string }[] };
		expect(archived.notes[0]?.superseded_by).toBe("piso-de-oviedo");
	});

	it("searches by section with accents and prefixes, excluding the archive", async () => {
		env = await makeMemory(SEED);
		const r = env.memory.search({ query: "hipoteca prestamo" });
		expect(r.hits.map((h) => h.path)).toEqual(["temas/piso-de-oviedo.md"]);
		expect(r.hits[0]?.snippet).toContain("«");
		const exams = env.memory.search({ query: "enero" });
		expect(exams.hits[0]?.section.heading).toBe("Exámenes");
		const withArchive = env.memory.search({ query: "hipoteca", include_archive: true });
		expect(withArchive.hits.map((h) => h.path)).toContain("archivo/viejo.md");
		const anyMode = env.memory.search({ query: "estadistica zzzz" });
		expect(anyMode.mode).toBe("any");
		await expectCode(() => env!.memory.search({ query: "!!" }), "INVALID_ARGUMENT");
	});

	it("reads notes and sections by path or name", async () => {
		env = await makeMemory(SEED);
		const full = await env.memory.read({ name: "[[universidad]]" });
		expect(full.path).toBe("temas/universidad.md");
		expect(full.sections.map((s) => s.heading)).toEqual(["Universidad", "Este curso", "Exámenes"]);
		expect((full as { links_in?: number }).links_in).toBe(2);
		const sec = await env.memory.read({ path: "temas/universidad.md", section: "examenes" });
		expect(sec.content).toBe("## Exámenes\n\nEn enero.\n");
		expect(sec.hash).toBe(full.hash);
		await expectCode(env.memory.read({ name: "universidat" }), "NOT_FOUND").then((e) => expect(e.details.suggestions).toContain("temas/universidad.md"));
		await expectCode(env.memory.read({ path: "temas/universidad.md", section: "nada" }), "SECTION_NOT_FOUND");
		await expectCode(env.memory.read({ path: "temas/universidad.md", name: "x" }), "INVALID_ARGUMENT");
	});

	it("gives links both ways with context, and history with trailers", async () => {
		env = await makeMemory(SEED);
		const l = (await env.memory.links({ name: "universidad" })) as { in: { src_path: string; context: string }[] };
		expect(l.in.map((x) => x.src_path).sort()).toEqual(["temas/piso-de-oviedo.md", "yo/perfil.md"]);
		const out = (await env.memory.links({ name: "piso-de-oviedo", direction: "out" })) as { out: { target_path: string; heading?: string }[] };
		expect(out.out).toEqual([{ target_name: "universidad", target_path: "temas/universidad.md", heading: "Exámenes", line: 7 }]);
		await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "En enero.", new_string: "En enero y junio." }], reason: "Añadir junio" });
		const h = await env.memory.history({ name: "universidad" });
		expect(h.commits[0]).toMatchObject({ author: "Test Writer", message: "Añadir junio", trailers: { Client: "test-writer", Tool: "edit" } });
	});
});

describe("relations", () => {
	it("indexes typed links, filters by relation and lists keys in the instructions", async () => {
		env = await makeMemory({
			...SEED,
			"personas/sara.md": note("Sara", "Amiga de Alex", "estudia_en:: [[universidad]]\n\nVive en [[piso-de-oviedo]]."),
		});
		const all = (await env.memory.links({ name: "universidad", direction: "in" })) as { in: { src_path: string; relation?: string }[] };
		expect(all.in.find((l) => l.src_path === "personas/sara.md")?.relation).toBe("estudia_en");
		const typed = (await env.memory.links({ name: "universidad", direction: "in", relation: "Estudia_en::" })) as { in: { src_path: string }[] };
		expect(typed.in.map((l) => l.src_path)).toEqual(["personas/sara.md"]);
		const out = (await env.memory.links({ name: "viejo", direction: "out" })) as { out: { relation?: string }[] };
		expect(out.out[0]?.relation).toBe("sustituida_por");
		expect(await env.memory.instructions()).toContain("already in use (reuse them rather than inventing synonyms): estudia_en, sustituida_por.");
	});

	it("warns about relation keys outside the allowed list", async () => {
		const conventions = `${CONVENTIONS}\n[relations]\nallowed = ["estudia_en", "sustituida_por"]\n`;
		env = await makeMemory({ "memory.toml": conventions, "temas/universidad.md": note("Universidad", "Carrera"), "personas/ana.md": note("Ana", "Amiga", "va_a:: [[universidad]]") });
		expect(env.memory.list({ folder: "personas" })).toMatchObject({ notes: [{ problems: ["relation «va_a» is not in the allowed list"] }] });
		const r = await env.memory.create(writer, { path: "personas/luis.md", content: note("Luis", "Amigo", "estudia_en:: [[universidad]]\nprofe_de:: [[universidad]]"), reason: "Nueva persona" });
		expect(r.warnings).toMatchObject([{ code: "UNKNOWN_RELATIONS", relations: ["profe_de"] }]);
		expect(await env.memory.instructions()).toContain("Relation keys of this memory: estudia_en, sustituida_por.");
	});
});

describe("writing", () => {
	it("creates a note with a commit attributed to the client and pushes it", async () => {
		env = await makeMemory(SEED);
		const r = await env.memory.create({ ...writer, session: "chat-42" }, { path: "personas/sara.md", content: note("Sara", "Amiga de Alex", "Ver [[perfil]] y [[inexistente]]."), reason: "Nueva persona" });
		expect(r.warnings.map((w) => w.code)).toEqual(["BROKEN_LINKS"]);
		expect(r.hash).toBe((await env.memory.read({ path: "personas/sara.md" })).hash);
		const remoteLog = await new Git(env.root).out(["--git-dir", env.bare as string, "log", "-1", "--format=%an <%ae>|%B"]);
		expect(remoteLog).toContain("Test Writer <test-writer@my-memory.invalid>|Nueva persona");
		expect(remoteLog).toContain("Session: chat-42");
		expect(env.memory.search({ query: "amiga" }).hits[0]?.path).toBe("personas/sara.md");
		const back = (await env.memory.links({ name: "perfil", direction: "in" })) as { in: unknown[] };
		expect(back.in).toHaveLength(1);
	});

	it("guards create: path, name uniqueness, frontmatter, duplicates", async () => {
		env = await makeMemory(SEED);
		const c = (path: string, content: string, confirm_new = false) => env!.memory.create(writer, { path, content, reason: "x", confirm_new });
		await expectCode(c("temas/universidad.md", note("U", "d")), "ALREADY_EXISTS");
		await expectCode(c("proyectos/universidad.md", note("U2", "d")), "NAME_TAKEN");
		await expectCode(c("temas/Mal.md", note("M", "d")), "INVALID_FILENAME");
		await expectCode(c("otros/x.md", note("X", "d")), "INVALID_PATH");
		await expectCode(c("temas/sin-desc.md", "---\nname: X\n---\n"), "INVALID_FRONTMATTER");
		const dup = await expectCode(c("temas/universidades.md", note("La universidad", "Otra")), "DUPLICATE_CANDIDATES");
		expect((dup.details.candidates as { path: string }[]).map((x) => x.path)).toContain("temas/universidad.md");
		await expect(c("temas/universidades.md", note("La universidad", "Otra"), true)).resolves.toMatchObject({ path: "temas/universidades.md" });
		await expectCode(env.memory.create(reader, { path: "temas/r.md", content: note("R", "d"), reason: "x" }), "FORBIDDEN");
		await expectCode(env.memory.create(writer, { path: "temas/r.md", content: note("R", "d"), reason: " " }), "INVALID_ARGUMENT");
	});

	it("edits with exact replacements, atomically", async () => {
		env = await makeMemory(SEED);
		const before = await env.memory.read({ name: "universidad" });
		await expectCode(env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }, { old_string: "nope", new_string: "x" }], reason: "x" }), "EDIT_NO_MATCH");
		expect((await env.memory.read({ name: "universidad" })).hash).toBe(before.hash);
		await expectCode(env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "\n\n", new_string: "\n" }], reason: "x" }), "EDIT_AMBIGUOUS");
		await expectCode(env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], hash: "0".repeat(40), reason: "x" }), "CONFLICT");
		await expectCode(env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "description: Carrera y asignaturas", new_string: "description: |\n  a\n  b" }], reason: "x" }), "INVALID_FRONTMATTER");
		const r = await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }, { old_string: "Seis", new_string: "Siete" }], reason: "Cambio" });
		expect(await readFile(join(env.root, "data/repo/temas/universidad.md"), "utf8")).toContain("Siete asignaturas");
		expect(r.commit).not.toBeNull();
		const same = await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Siete", new_string: "Siete" }], reason: "nada" });
		expect(same.warnings.map((w) => w.code)).toContain("NO_CHANGES");
	});

	it("write requires the hash read before", async () => {
		env = await makeMemory(SEED);
		const cur = await env.memory.read({ name: "universidad" });
		await expectCode(env.memory.write(writer, { name: "universidad", content: note("Universidad", "d"), hash: "", reason: "x" }), "INVALID_ARGUMENT");
		const conflict = await expectCode(env.memory.write(writer, { name: "universidad", content: note("Universidad", "d"), hash: "f".repeat(40), reason: "x" }), "CONFLICT");
		expect(conflict.details.hash).toBe(cur.hash);
		const r = await env.memory.write(writer, { name: "universidad", content: note("Universidad", "Nueva"), hash: cur.hash, reason: "Reescrita" });
		expect(r.hash).not.toBe(cur.hash);
	});

	it("moves notes and rewrites incoming links in the same commit", async () => {
		env = await makeMemory(SEED);
		const cur = await env.memory.read({ name: "piso-de-oviedo" });
		const r = await env.memory.move(writer, { from: "temas/piso-de-oviedo.md", to: "archivo/piso-oviedo-antiguo.md", hash: cur.hash, reason: "Archivar" });
		expect(r.links_rewritten).toBe(2); // perfil and the archived note's sustituida_por
		expect(await readFile(join(env.root, "data/repo/yo/perfil.md"), "utf8")).toContain("[[piso-oviedo-antiguo]]");
		expect(await readFile(join(env.root, "data/repo/archivo/viejo.md"), "utf8")).toContain('"[[piso-oviedo-antiguo]]"');
		const files = await new Git(join(env.root, "data/repo")).out(["show", "--no-renames", "--name-only", "--format=", "HEAD"]);
		expect(files.trim().split("\n").sort()).toEqual(["archivo/piso-oviedo-antiguo.md", "archivo/viejo.md", "temas/piso-de-oviedo.md", "yo/perfil.md"]);
		const broken = env.memory.index.brokenLinks().filter((l) => l.srcPath !== "AGENTS.md");
		expect(broken).toEqual([]);
		await expectCode(env.memory.move(writer, { from: "temas/universidad.md", to: "temas/perfil.md", hash: (await env.memory.read({ name: "universidad" })).hash, reason: "x" }), "NAME_TAKEN");
	});

	it("deletes only without backlinks", async () => {
		env = await makeMemory(SEED);
		const uni = await env.memory.read({ name: "universidad" });
		const e = await expectCode(env.memory.delete(writer, { name: "universidad", hash: uni.hash, reason: "x" }), "HAS_BACKLINKS");
		expect((e.details.backlinks as unknown[]).length).toBe(2);
		const perfil = await env.memory.read({ name: "perfil" });
		await env.memory.delete(writer, { name: "perfil", hash: perfil.hash, reason: "Fuera" });
		await expectCode(env.memory.read({ name: "perfil" }), "NOT_FOUND");
		await expectCode(env.memory.delete(writer, { path: "AGENTS.md", hash: "x", reason: "x" }), "INVALID_PATH");
	});

	it("serializes concurrent edits without losing any", { timeout: 120_000 }, async () => {
		env = await makeMemory(SEED);
		const n = 6;
		await Promise.all(
			Array.from({ length: n }, (_, i) =>
				env!.memory.edit(writer, { name: "universidad", edits: [{ old_string: "En enero.", new_string: `En enero.\nLínea ${i}.` }], reason: `Línea ${i}` }),
			),
		);
		const text = await readFile(join(env.root, "data/repo/temas/universidad.md"), "utf8");
		for (let i = 0; i < n; i++) expect(text).toContain(`Línea ${i}.`);
		const cur = await env.memory.read({ name: "universidad" });
		const results = await Promise.allSettled([0, 1, 2].map((i) => env!.memory.write(writer, { name: "universidad", content: note("Universidad", `v${i}`), hash: cur.hash, reason: `w${i}` })));
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((r) => r.status === "rejected").map((r) => ((r as PromiseRejectedResult).reason as MemoryError).code)).toEqual(["CONFLICT", "CONFLICT"]);
	});
});

describe("recent and revert", () => {
	const repoGit = () => new Git(join(env!.root, "data/repo"));

	it("lists recent commits with client, tool, reason and the notes they touched", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		await m.create({ ...writer, session: "s-1" }, { path: "personas/sara.md", content: note("Sara", "Amiga"), reason: "Nueva persona" });
		await m.edit({ id: "otro", name: "Otro Agente", scope: "write" }, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], reason: "Seis asignaturas" });
		const piso = await m.read({ name: "piso-de-oviedo" });
		await m.move(writer, { from: "piso-de-oviedo", to: "temas/piso.md", hash: piso.hash, reason: "Renombrar" });
		await m.edit(writer, { name: "viejo", edits: [{ old_string: "antigua", new_string: "muy antigua" }], reason: "Solo archivo" });

		const r = await m.recent({});
		expect(r.commits.map((c) => c.reason)).toEqual(["Renombrar", "Seis asignaturas", "Nueva persona", "seed"]);
		expect(r.commits[0]).toMatchObject({ author: "Test Writer", client: "test-writer", tool: "move" });
		expect(r.commits[0]?.notes).toContainEqual({ path: "temas/piso.md", name: "piso", change: "moved", from: "temas/piso-de-oviedo.md" });
		expect(r.commits[0]?.notes).toContainEqual({ path: "yo/perfil.md", name: "perfil", change: "modified" });
		expect(r.commits[0]?.notes.map((n) => n.path)).not.toContain("archivo/viejo.md"); // archive hidden
		expect(r.commits[2]).toMatchObject({ client: "test-writer", tool: "create", session: "s-1", notes: [{ path: "personas/sara.md", name: "sara", change: "added" }] });
		expect(r.commits[3]).toMatchObject({ author: "Seeder", client: null, tool: null });

		const withArchive = await m.recent({ include_archive: true, limit: 2 });
		expect(withArchive.commits.map((c) => c.reason)).toEqual(["Solo archivo", "Renombrar"]);
		expect((await m.recent({ folder: "archivo" })).commits[0]?.reason).toBe("Solo archivo");
		expect((await m.recent({ client: "otro" })).commits.map((c) => c.reason)).toEqual(["Seis asignaturas"]);
		expect((await m.recent({ client: "seeder" })).commits.map((c) => c.reason)).toEqual(["seed"]);
		expect((await m.recent({ folder: "personas" })).commits.map((c) => c.reason)).toEqual(["Nueva persona"]);
		expect((await m.recent({ since: "1d" })).commits).toHaveLength(4);
		expect((await m.recent({ since: "2999-01-01" })).commits).toEqual([]);
		await expectCode(m.recent({ since: "ayer" }), "INVALID_ARGUMENT");
		await expectCode(m.recent({ folder: "../x" }), "INVALID_ARGUMENT");
	});

	it("reverts an edit with one attributed commit, keeping later changes that do not overlap", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		const first = await m.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], reason: "Seis" });
		await m.edit(writer, { name: "universidad", edits: [{ old_string: "En enero.", new_string: "En enero y junio." }], reason: "Junio" });
		const r = await m.revert({ ...writer, session: "s-2" }, { commit: (first.commit as string).slice(0, 10), reason: "Eran cinco" });
		expect(r).toMatchObject({ path: "temas/universidad.md", reverted: first.commit, changes: [{ path: "temas/universidad.md", change: "reverted" }], warnings: [] });
		const text = (await m.read({ name: "universidad" })).content;
		expect(text).toContain("Cinco asignaturas");
		expect(text).toContain("En enero y junio.");
		expect(r.hash).toBe((await m.read({ name: "universidad" })).hash);
		const remoteLog = await new Git(env.root).out(["--git-dir", env.bare as string, "log", "-1", "--format=%an|%B"]);
		expect(remoteLog).toContain("Test Writer|Eran cinco");
		expect(remoteLog).toContain(`Reverts: ${first.commit}`);
		expect(remoteLog).toContain("Session: s-2");
		expect((await m.recent({ limit: 1 })).commits[0]).toMatchObject({ tool: "revert", reverts: first.commit });
		expect(m.search({ query: "cinco" }).hits[0]?.path).toBe("temas/universidad.md");
		// Done already: nothing to change.
		const again = await m.revert(writer, { commit: first.commit as string, reason: "Otra vez" });
		expect(again.warnings.map((w) => w.code)).toEqual(["NO_CHANGES"]);
	});

	it("refuses a revert that collides with later changes and leaves everything as it was", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		const first = await m.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], reason: "Seis" });
		const second = await m.edit(writer, { name: "universidad", edits: [{ old_string: "Seis", new_string: "Siete" }], reason: "Siete" });
		const e = await expectCode(m.revert(writer, { commit: first.commit as string, reason: "x" }), "REVERT_CONFLICT");
		expect(e.details).toMatchObject({ path: "temas/universidad.md", later_commits: [{ commit: second.commit, message: "Siete" }] });
		expect(await repoGit().head()).toBe(second.commit);
		expect(await repoGit().isClean()).toBe(true);
		expect((await m.read({ name: "universidad" })).content).toContain("Siete asignaturas");
	});

	it("reverting a create deletes the note, but not while others link to it; reverting a delete restores it", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		const ana = await m.create(writer, { path: "personas/ana.md", content: note("Ana", "Prima"), reason: "Ana" });
		const luis = await m.create(writer, { path: "personas/luis.md", content: note("Luis", "Primo", "Hermano de [[ana]]."), reason: "Luis" });
		const e = await expectCode(m.revert(writer, { commit: ana.commit as string, reason: "Sin Ana" }), "HAS_BACKLINKS");
		expect(e.details.backlinks).toEqual([{ src_path: "personas/luis.md", line: 7, target: "personas/ana.md" }]);
		expect(await repoGit().isClean()).toBe(true);
		const r = await m.revert(writer, { commit: luis.commit as string, reason: "Sin Luis" });
		expect(r).toMatchObject({ changes: [{ path: "personas/luis.md", change: "removed" }], hash: null });
		await expectCode(m.read({ name: "luis" }), "NOT_FOUND");
		await m.revert(writer, { commit: ana.commit as string, reason: "Sin Ana" });
		await expectCode(m.read({ name: "ana" }), "NOT_FOUND");

		const perfil = await m.read({ name: "perfil" });
		const del = await m.delete(writer, { name: "perfil", hash: perfil.hash, reason: "Fuera" });
		const back = await m.revert(writer, { commit: del.commit as string, reason: "Volver" });
		expect(back).toMatchObject({ path: "yo/perfil.md", hash: perfil.hash, changes: [{ path: "yo/perfil.md", change: "restored" }] });
		expect(m.search({ query: "Alex" }).hits.map((h) => h.path)).toContain("yo/perfil.md");
		expect(((await m.links({ name: "universidad", direction: "in" })) as { in: unknown[] }).in).toHaveLength(2);
		// Created again in between: the old one does not overwrite it.
		const del2 = await m.delete(writer, { name: "perfil", hash: perfil.hash, reason: "Fuera otra vez" });
		await m.create(writer, { path: "yo/perfil.md", content: note("Perfil", "Nuevo perfil"), reason: "Nuevo", confirm_new: true });
		await expectCode(m.revert(writer, { commit: del2.commit as string, reason: "x" }), "REVERT_CONFLICT");
	});

	it("reverts a move with its link rewrites, or only one note of it", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		const piso = await m.read({ name: "piso-de-oviedo" });
		const mv = await m.move(writer, { from: "temas/piso-de-oviedo.md", to: "temas/piso.md", hash: piso.hash, reason: "Renombrar" });
		const one = await m.revert(writer, { commit: mv.commit as string, name: "[[perfil]]", reason: "Solo el perfil" });
		expect(one.changes).toEqual([{ path: "yo/perfil.md", change: "reverted" }]);
		expect(one.warnings).toMatchObject([{ code: "BROKEN_LINKS", targets: ["piso-de-oviedo"], path: "yo/perfil.md" }]);
		expect(await m.read({ name: "piso" })).toMatchObject({ path: "temas/piso.md" });
		await expectCode(m.revert(writer, { commit: mv.commit as string, path: "temas/universidad.md", reason: "x" }), "NOT_FOUND");

		const all = await m.revert(writer, { commit: mv.commit as string, reason: "Deshacer el cambio de nombre" });
		expect(all.changes).toContainEqual({ path: "temas/piso-de-oviedo.md", change: "moved_back", from: "temas/piso.md" });
		expect(all.changes).toContainEqual({ path: "archivo/viejo.md", change: "reverted" });
		expect(all.changes).not.toContainEqual(expect.objectContaining({ path: "yo/perfil.md" })); // already back
		expect((await m.read({ name: "piso-de-oviedo" })).content).toBe(piso.content);
		await expectCode(m.read({ name: "piso" }), "NOT_FOUND");
		expect(m.index.brokenLinks().filter((l) => l.srcPath !== "AGENTS.md")).toEqual([]);
	});

	it("validates the commit and the client", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		const first = await m.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], reason: "Seis" });
		await expectCode(m.revert(writer, { commit: "0123456789abcdef", reason: "x" }), "INVALID_REVISION");
		await expectCode(m.revert(writer, { commit: "--all", reason: "x" }), "INVALID_REVISION");
		await expectCode(m.revert(writer, { commit: "", reason: "x" }), "INVALID_ARGUMENT");
		const tree = (await repoGit().out(["rev-parse", "HEAD^{tree}"])).trim();
		const dangling = (await repoGit().run(["commit-tree", tree, "-m", "fuera de la rama"])).stdout.trim();
		await expectCode(m.revert(writer, { commit: dangling, reason: "x" }), "INVALID_REVISION");
		await expectCode(m.revert(reader, { commit: first.commit as string, reason: "x" }), "FORBIDDEN");
		await expectCode(m.revert(writer, { commit: first.commit as string, reason: "" }), "INVALID_ARGUMENT");
		expect(await repoGit().head()).toBe(first.commit);
	});

	it("removes an attachment when undoing attach, but never rewrites a binary from history", { timeout: 60_000 }, async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		if (!(await m.git.lfsAvailable())) return;
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]).toString("base64");
		const att = await m.attach(writer, { path: "temas/foto.png", source: { base64: png }, description: "Una foto", reason: "Foto" });
		const attrs = await readFile(join(env.root, "data/repo/.gitattributes"), "utf8");
		const undo = await m.revert(writer, { commit: att.commit as string, reason: "Sin foto" });
		expect((undo.changes as { path: string }[]).map((c) => c.path).sort()).toEqual(["temas/foto.md", "temas/foto.png"]);
		expect(await readFile(join(env.root, "data/repo/.gitattributes"), "utf8")).toBe(attrs); // LFS rules stay
		await expectCode(m.read({ name: "foto" }), "NOT_FOUND");
		const e = await expectCode(m.revert(writer, { commit: undo.commit as string, reason: "Volver a poner la foto" }), "NOT_RESTORABLE");
		expect(e.details.path).toBe("temas/foto.png");
		expect(await repoGit().isClean()).toBe(true);
		// The note alone can come back.
		const back = await m.revert(writer, { commit: undo.commit as string, path: "temas/foto.md", reason: "Solo la nota" });
		expect(back.changes).toEqual([{ path: "temas/foto.md", change: "restored" }]);
	});
});

describe("remote sync", () => {
	it("integrates pushes from elsewhere (webhook) and rebases local writes on top", async () => {
		env = await makeMemory(SEED);
		const other = await otherClone(env.root, env.bare as string);
		await other.write("temas/coche.md", note("Coche", "Camión de mudanza", "Revisión en marzo."));
		await other.commitPush("Coche desde el PC");
		env.memory.requestSync("webhook");
		await new Promise((r) => setTimeout(r, 400));
		await env.memory.idle();
		expect(env.memory.search({ query: "camion" }).hits[0]?.path).toBe("temas/coche.md");
		// Remote moves again without telling us; our write gets rejected, rebased, and pushed.
		await other.write("temas/telefono.md", note("Teléfono", "Líneas", "Fibra óptica."));
		await other.commitPush("Teléfono");
		const r = await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], reason: "Seis" });
		expect(r.warnings).toEqual([]);
		const remoteLog = await new Git(env.root).out(["--git-dir", env.bare as string, "log", "--format=%s", "-3"]);
		expect(remoteLog.trim().split("\n")).toEqual(["Seis", "Teléfono", "Coche desde el PC"]);
		expect(env.memory.search({ query: "optica" }).hits[0]?.path).toBe("temas/telefono.md");
	});

	it("drops the local change when it collides with the remote (remote wins)", async () => {
		env = await makeMemory(SEED);
		const other = await otherClone(env.root, env.bare as string);
		const text = await readFile(join(other.dir, "temas/universidad.md"), "utf8");
		await other.write("temas/universidad.md", text.replace("Cinco", "Ocho"));
		await other.commitPush("Ocho");
		const e = await expectCode(env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], reason: "Seis" }), "REMOTE_CONFLICT");
		expect(e.details.content).toContain("Ocho asignaturas");
		expect((await env.memory.read({ name: "universidad" })).content).toContain("Ocho asignaturas");
		expect(env.memory.search({ query: "ocho" }).hits).toHaveLength(1);
	});

	it("keeps working when the remote is down and pushes later", async () => {
		env = await makeMemory(SEED);
		const repo = new Git(join(env.root, "data/repo"));
		await repo.run(["remote", "set-url", "origin", join(env.root, "missing.git")]);
		const r = await env.memory.edit(writer, { name: "universidad", edits: [{ old_string: "Cinco", new_string: "Seis" }], reason: "Seis" });
		expect(r.warnings.map((w) => w.code)).toEqual(["PUSH_PENDING"]);
		await repo.run(["remote", "set-url", "origin", env.bare as string]);
		await new Promise((res) => setTimeout(res, 300));
		await env.memory.idle();
		const remoteLog = await new Git(env.root).out(["--git-dir", env.bare as string, "log", "--format=%s", "-1"]);
		expect(remoteLog.trim()).toBe("Seis");
	});
});

describe("index lifecycle", () => {
	it("incremental index equals a full rebuild after a run of operations", async () => {
		env = await makeMemory(SEED);
		const m = env.memory;
		await m.create(writer, { path: "personas/ana.md", content: note("Ana", "Prima", "Conoce a [[sara]] y [[perfil]]."), reason: "a" });
		await m.create(writer, { path: "personas/sara.md", content: note("Sara", "Amiga", "Ver [[ana]]."), reason: "b" });
		const ana = await m.read({ name: "ana" });
		await m.move(writer, { from: "personas/ana.md", to: "personas/ana-maria.md", hash: ana.hash, reason: "c" });
		await m.edit(writer, { name: "perfil", edits: [{ old_string: "Estudia", new_string: "Estudia mucho" }], reason: "d" });
		const sara = await m.read({ name: "sara" });
		await m.write(writer, { name: "sara", content: note("Sara", "Amiga de Alex"), hash: sara.hash, reason: "e" });
		const snapshot = (idx: SearchIndex) => ({
			notes: idx.allNotes().map((n) => ({ ...n, createdAt: null, updatedAt: null })),
			links: idx.db.prepare("SELECT * FROM links ORDER BY src_path, line, target_name").all(),
			sections: idx.db.prepare("SELECT path, heading, level, line_start, line_end FROM sections ORDER BY path, ord").all(),
			fts: idx.db.prepare("SELECT rowid, title, heading, body FROM sections_fts ORDER BY rowid").all().length,
		});
		const incremental = snapshot(m.index);
		await m.rebuildIndex();
		expect(snapshot(m.index)).toEqual(incremental);
	});

	it("recovers at startup from a dirty worktree and a stale index", async () => {
		env = await makeMemory(SEED);
		await env.memory.stop();
		const repo = join(env.root, "data/repo");
		await writeFile(join(repo, "temas/universidad.md"), "half written");
		await writeFile(join(repo, "temas/basura.md"), "untracked");
		const other = await otherClone(env.root, env.bare as string);
		await other.write("temas/nueva.md", note("Nueva", "Hecha mientras estaba apagado"));
		await other.commitPush("nueva");
		const memory = new MemoryService({ ...env.memory.opts });
		await memory.start();
		env.memory = memory;
		expect((await memory.read({ name: "universidad" })).content).toContain("Cinco asignaturas");
		await expectCode(memory.read({ name: "basura" }), "NOT_FOUND");
		expect(memory.search({ query: "apagado" }).hits[0]?.path).toBe("temas/nueva.md");
	});
});
