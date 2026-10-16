import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConventions } from "../src/conventions.js";
import { lenientYaml, parseNote } from "../src/frontmatter.js";
import { Git } from "../src/git.js";
import { applyMigration, planMigration, quoteFrontmatter, slugify } from "../src/migrate.js";
import { CONVENTIONS, makeMemory, seedRemote, tempDir, writer } from "./helpers.js";
import { rm } from "node:fs/promises";

const LEGACY = '---\nname: Telefonía\ndescription: Líneas de casa: móvil y fibra\naliases: [móvil, internet]\n---\n# Telefonía\n\nVer [Universidad](../temas/universidad.md).\n';

describe("legacy frontmatter", () => {
	it("is read leniently but reported", () => {
		const conv = parseConventions(CONVENTIONS);
		const n = parseNote(LEGACY, conv);
		expect(n.meta.description).toBe("Líneas de casa: móvil y fibra");
		expect(n.meta.aliases).toEqual(["móvil", "internet"]);
		expect(n.problems).toHaveLength(1);
		expect(n.problems[0]).toMatch(/not valid YAML/);
		expect(lenientYaml("a: x\nb: >\n  uno\n  dos\nc:\n  - p\n  - q")).toEqual({ a: "x", b: "uno dos", c: ["p", "q"] });
	});

	it("gets quoted by the migration, touching only the bad lines", () => {
		const fixed = quoteFrontmatter(LEGACY) as string;
		expect(fixed).toContain('description: "Líneas de casa: móvil y fibra"');
		expect(fixed).toContain("aliases: [móvil, internet]");
		expect(quoteFrontmatter(fixed)).toBeNull();
	});

	it("still lets agents edit the body of a note with old frontmatter", async () => {
		const env = await makeMemory({ "temas/telefonia.md": LEGACY.replace("../temas/universidad.md", "x") });
		try {
			expect((env.memory.list({ folder: "temas" }) as { notes: { problems?: string[] }[] }).notes[0]?.problems).toHaveLength(1);
			const r = await env.memory.edit(writer, { name: "telefonia", edits: [{ old_string: "# Telefonía", new_string: "# Telefonía y fibra" }], reason: "x" });
			expect(r.warnings.map((w) => w.code)).toContain("FRONTMATTER_PROBLEMS");
			await expect(env.memory.edit(writer, { name: "telefonia", edits: [{ old_string: "aliases: [móvil, internet]", new_string: "aliases: [móvil]" }], reason: "x" })).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
		} finally {
			await env.cleanup();
		}
	});
});

describe("migration", () => {
	let root: string | null = null;
	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 });
		root = null;
	});

	it("converts relative links to wikilinks with unique names, in one commit", async () => {
		root = await tempDir();
		const bare = await seedRemote(root, {
			"README.md": "# Memoria\n\n- [yo/](yo/)\n- [Normas](AGENTS.md)\n",
			"AGENTS.md": "# Normas\n",
			"yo/perfil.md": "---\nname: Perfil\ndescription: Quién es\n---\n# Perfil\n\nEstudia ([Universidad](../temas/universidad.md)), ver [exámenes](../temas/universidad.md#exámenes-de-enero) y [la web](https://example.com).\n\n| Tema | Enlace |\n|---|---|\n| Uni | [la uni](../temas/universidad.md) |\n\n`[código](../temas/universidad.md)`\n\n![foto](../temas/foto.png)\n",
			"temas/universidad.md": "---\nname: Universidad\ndescription: Carrera\n---\n# Universidad\n\n## Exámenes de enero\n\nTexto. Ver [perfil](../yo/perfil.md) y [roto](../temas/nada.md).\n",
			"temas/foto.png": "png",
			"archivo/README.md": "# Archivo\n\nVer [el índice](../README.md).\n",
		});
		const clone = join(root, "clone");
		await new Git(root).run(["clone", "-q", bare, clone]);
		const plan = await planMigration(clone);
		expect(plan.renames).toEqual([{ from: "archivo/README.md", to: "archivo/archivo.md" }]);
		expect(plan.broken).toEqual([]);
		expect(plan.issues.map((i) => i.link)).toEqual(["[yo/](yo/)", "[roto](../temas/nada.md)"]);
		const files = Object.fromEntries(plan.files.map((f) => [f.path, f.content]));
		const perfil = files["yo/perfil.md"] as string;
		expect(perfil).toContain("Estudia ([[universidad]]), ver [[universidad#Exámenes de enero|exámenes]] y [la web](https://example.com).");
		expect(perfil).toContain("| Uni | [[universidad\\|la uni]] |");
		expect(perfil).toContain("`[código](../temas/universidad.md)`");
		expect(perfil).toContain("![[foto.png]]");
		expect(files["README.md"]).toContain("[[AGENTS|Normas]]");
		expect(files["archivo/README.md"]).toContain("[[README|el índice]]");
		expect(slugify("Exámenes de enero")).toBe("exámenes-de-enero");

		const commit = await applyMigration(clone, plan, { conventions: CONVENTIONS });
		const git = new Git(clone);
		expect(await git.out(["log", "-1", "--format=%an|%s", commit])).toBe("my-memory migration|Migrate links to [[wikilinks]] with unique names\n");
		expect(await git.out(["rev-list", "--count", "HEAD"])).toBe("2\n");
		expect(await readFile(join(clone, "archivo/archivo.md"), "utf8")).toContain("[[README|el índice]]");
		expect(await readFile(join(clone, "memory.toml"), "utf8")).toBe(CONVENTIONS);
	});
});
