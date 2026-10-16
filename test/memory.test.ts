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
