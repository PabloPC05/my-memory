import { describe, expect, it } from "vitest";
import { defaultConventions, parseConventions } from "../src/conventions.js";
import { parseNote, splitFrontmatter } from "../src/frontmatter.js";
import { maskCode, parseWikiLinks, rewriteWikiLinks, splitSections } from "../src/markdown.js";
import { parseTypedLinks } from "../src/relations.js";
import { buildFtsQuery } from "../src/search-index.js";
import { blobHash, checkNewFilename, checkPath, looksLikeSame } from "../src/util.js";
import { CONVENTIONS } from "./helpers.js";

const conv = parseConventions(CONVENTIONS);

describe("frontmatter", () => {
	it("splits frontmatter with BOM and CRLF", () => {
		const s = splitFrontmatter("\uFEFF---\r\nname: X\r\n---\r\nbody\r\n");
		expect(s.yaml).toBe("name: X");
		expect(s.body).toBe("body\r\n");
		expect(s.bodyLine).toBe(4);
	});

	it("reads flow and block aliases, quotes and folded descriptions", () => {
		const flow = parseNote("---\nname: 'A'\ndescription: \"d\"\naliases: [x, y]\n---\n", conv);
		expect(flow.meta.aliases).toEqual(["x", "y"]);
		expect(flow.problems).toEqual([]);
		const block = parseNote("---\nname: A\ndescription: >\n  una línea\naliases:\n  - uno\n  - dos\n---\n", conv);
		expect(block.meta.aliases).toEqual(["uno", "dos"]);
		expect(block.meta.description).toBe("una línea");
	});

	it("reports missing fields, multi-line description and bad YAML", () => {
		expect(parseNote("no frontmatter", conv).problems).toContain("missing frontmatter");
		expect(parseNote("---\nname: A\n---\n", conv).problems).toContain("missing required field «description»");
		expect(parseNote("---\nname: A\ndescription: |\n  a\n  b\n---\n", conv).problems[0]).toMatch(/single line/);
		expect(parseNote("---\nname: [unclosed\ndescription: d\n---\n", conv).problems[0]).toMatch(/not valid YAML/);
	});

	it("reads the superseded field as a link target", () => {
		const n = parseNote('---\nname: A\ndescription: d\nsustituida_por: "[[nueva-nota]]"\n---\n', conv);
		expect(n.meta.superseded).toBe("nueva-nota");
	});
});

describe("markdown", () => {
	it("masks fenced and inline code without moving offsets", () => {
		const text = "a `[[x]]` b\n```\n[[y]]\n```\n[[z]]";
		const masked = maskCode(text);
		expect(masked.length).toBe(text.length);
		expect(parseWikiLinks(text).map((l) => l.targetName)).toEqual(["z"]);
	});

	it("parses aliases, headings, embeds, escaped pipes and folders", () => {
		const links = parseWikiLinks("[[Nota|texto]] ![[doc.pdf]] [[carpeta/otra#Sección]] | [[tabla\\|alias]] | [[#local]]");
		expect(links.map((l) => [l.targetName, l.heading, l.alias, l.embed])).toEqual([
			["nota", null, "texto", false],
			["doc.pdf", null, null, true],
			["otra", "Sección", null, false],
			["tabla", null, "alias", false],
		]);
	});

	it("rewrites only matching targets and keeps heading and alias", () => {
		const out = rewriteWikiLinks("[[vieja]] [[vieja#H|t]] [[otra]] `[[vieja]]` | [[vieja\\|x]] |", (l) => (l.targetName === "vieja" ? "nueva" : null));
		expect(out.text).toBe("[[nueva]] [[nueva#H|t]] [[otra]] `[[vieja]]` | [[nueva\\|x]] |");
		expect(out.count).toBe(3);
	});

	it("splits sections at ## and ###, ignoring headings in code", () => {
		const body = "# T\n\nintro\n\n## Uno\n\ntexto\n\n#### dentro\n\n```\n## no\n```\n\n### Dos\n\nfin\n";
		const s = splitSections(body, 5, "T");
		expect(s.map((x) => [x.heading, x.level, x.lineStart])).toEqual([
			["T", 1, 5],
			["Uno", 2, 9],
			["Dos", 3, 19],
		]);
		expect(s[1]?.text).toContain("#### dentro");
		expect(s[1]?.text).toContain("## no");
	});
});

describe("relations", () => {
	it("types links written as Dataview fields in the body", () => {
		const text = [
			"# Alex",
			"",
			"trabaja_en:: [[empresa-x]]",
			"- Hermanos:: [[ana]], [[luis]]",
			"Vive con [vive_con:: [[sara]]] y conoce a [[marta]] (pareja_de:: [[sara|Ele]]).",
			"`no:: [[codigo]]`",
			"Texto con dos puntos: [[normal]]",
			"línea:: con [[x]] y [otra:: [[y]]] dentro",
		].join("\n");
		expect(parseTypedLinks(text).map((l) => [l.targetName, l.relation])).toEqual([
			["empresa-x", "trabaja_en"],
			["ana", "hermanos"],
			["luis", "hermanos"],
			["sara", "vive_con"],
			["marta", null],
			["sara", "pareja_de"],
			["normal", null],
			["x", "línea"],
			["y", "otra"],
		]);
	});

	it("types links in frontmatter fields, but not in text fields", () => {
		const text = '---\nname: X\ndescription: "Ver [[nada]]"\nsustituida_por: "[[nueva]]"\npadres:\n  - "[[ana]]"\n  - "[[juan]]"\n---\n# X\n\n[[suelta]]\n';
		expect(parseTypedLinks(text).map((l) => [l.targetName, l.relation])).toEqual([
			["nada", null],
			["nueva", "sustituida_por"],
			["ana", "padres"],
			["juan", "padres"],
			["suelta", null],
		]);
	});
});

describe("search query", () => {
	it("turns words into prefix terms and keeps phrases", () => {
		expect(buildFtsQuery('hipoteca "piso de oviedo" ir')).toEqual({ and: '"piso de oviedo" AND "hipoteca"* AND "ir"', or: '"piso de oviedo" OR "hipoteca"* OR "ir"' });
		expect(buildFtsQuery("¿?¡!")).toBeNull();
		expect(buildFtsQuery('a"b')?.and).toBe('"a" AND "b"');
	});
});

describe("paths and names", () => {
	it("rejects traversal, absolute, hidden and foreign folders", () => {
		for (const bad of ["../x.md", "/etc/x.md", "C:/x.md", "yo\\x.md", ".git/config.md", "yo/.obsidian/x.md", "otros/x.md", "x.md", "yo/x.txt", "yo//x.md"]) {
			expect(() => checkPath(bad, conv, "note"), bad).toThrow();
		}
		expect(checkPath("./yo/perfil.md", conv, "note")).toBe("yo/perfil.md");
		expect(checkPath("AGENTS.md", conv, "note")).toBe("AGENTS.md");
		expect(checkPath("temas/doc.pdf", conv, "asset")).toBe("temas/doc.pdf");
		expect(() => checkPath("temas/doc.md", conv, "asset")).toThrow();
	});

	it("checks the filename pattern for notes and attachments", () => {
		expect(() => checkNewFilename("yo/Perfil.md", conv)).toThrow(/pattern/);
		expect(() => checkNewFilename("temas/escritura-casa.pdf", conv)).not.toThrow();
		expect(() => checkNewFilename("temas/Escritura.PDF", conv)).toThrow();
	});

	it("detects look-alike labels", () => {
		expect(looksLikeSame("Seguro del Hogar", "seguro del hogar")).toBe(true);
		expect(looksLikeSame("Universidad", "universidad de verano")).toBe(true);
		expect(looksLikeSame("piso de oviedo", "piso de toledo")).toBe(false);
		expect(looksLikeSame("coche", "coches")).toBe(true);
		expect(looksLikeSame("ana", "eva")).toBe(false);
	});

	it("computes git blob hashes", () => {
		expect(blobHash("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
	});
});

describe("conventions", () => {
	it("has defaults and rejects invalid files", () => {
		expect(defaultConventions().folders.allowed).toBeNull();
		expect(conv.folders.archive).toBe("archivo");
		expect(conv.notes.supersededField).toBe("sustituida_por");
		expect(() => parseConventions('[notes]\nfilename_pattern = "("')).toThrow(/regular expression/);
		expect(() => parseConventions("[folders]\nallowed = [1]")).toThrow();
		expect(() => parseConventions('[attachments]\npage_heading = "Página"')).toThrow();
		expect(defaultConventions().relations.allowed).toBeNull();
		expect(parseConventions('[relations]\nallowed = ["Trabaja_en", "vive_con"]').relations.allowed).toEqual(["trabaja_en", "vive_con"]);
		expect(() => parseConventions('[relations]\nallowed = ["vive con"]')).toThrow(/relations.allowed/);
	});
});
