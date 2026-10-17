import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConventions, parseConventions } from "../src/conventions.js";
import { parseNote } from "../src/frontmatter.js";
import { type LintItem, lint } from "../src/lint.js";
import { splitSections } from "../src/markdown.js";
import { parseTypedLinks } from "../src/relations.js";
import { SearchIndex } from "../src/search-index.js";
import { blobHash, looksLikeSame, lookAlikePairs } from "../src/util.js";
import { CONVENTIONS, makeMemory, note, tempDir } from "./helpers.js";

const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const recent = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
const isoDate = expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/);

const SEED = {
	"AGENTS.md": "# Normas\n\nEnlaza con [[nombre]].\n",
	"yo/perfil.md": note(
		"Perfil",
		"Quién es Alex",
		`Estudia en la [[universidad]]. Vive en [[piso-de-oviedo]]. Va al [[gimnasio]].\n\n## Gustos\n\nLe gusta el té. Prefiere estudiar de noche (deducido, 2020-01-10)\n- Odia madrugar (deducido, ${recent})\n- Toca la guitarra (dicho, 2020-01-01)\n`,
		"aliases: [yo, Alex]\n",
	),
	"temas/universidad.md": note("Universidad", "Carrera y asignaturas", "## Este curso\n\nCinco asignaturas. Queda cerca del Piso de Oviedo, y del piso de oviedo otra vez.\n\nDespués, al [[gimnasio]] o a la [[cafeteria]].\n\n```\nAlex en un bloque de código no cuenta\n```\n"),
	"temas/piso-de-oviedo.md": note("Piso de Oviedo", "El piso y su hipoteca", "Cerca de la [[universidad]]. La hipoteca vence en 2040 (deducido)."),
	"temas/universidades.md": note("Universidades", "Otra nota sobre lo mismo", "Lista de universidades."),
	"temas/huerto.md": note("Huerto", "El huerto de casa", `Alex planta tomates.\n\n${"Riego por goteo. ".repeat(40)}`),
	"personas/ana.md": "---\nname: Ana\n---\n# Ana\n\nPrima de [[perfil]].\n",
	"personas/luis.md": note("Luis", "Antiguo compañero", "Ver [[ana]].", 'sustituida_por: "[[ana]]"\n'),
	"archivo/viejo.md": note("Viejo", "Nota archivada", "Enlaza a [[nada-de-nada]] y a [[otra-que-falta]]. Nadie la enlaza.", 'sustituida_por: "[[piso-de-oviedo]]"\n'),
};

let env: Awaited<ReturnType<typeof makeMemory>> | null = null;
afterEach(async () => {
	await env?.cleanup();
	env = null;
});

const ofKind = (items: LintItem[], kind: string) => items.filter((i) => i.kind === kind);

describe("lint", () => {
	it("finds every kind of candidate, worst first, leaving out root files and the archive", async () => {
		env = await makeMemory(SEED);
		const r = env.memory.lint({ limit: 500 });
		const kinds = r.items.map((i) => i.kind);
		expect(kinds).toEqual([...kinds].sort((a, b) => order(a) - order(b)));
		expect(r.items.every((i) => i.notes.every((p) => p.includes("/") && !p.startsWith("archivo/")))).toBe(true);
		expect(r.total).toBe(r.items.length);
		expect(r.truncated).toBe(false);

		expect(ofKind(r.items, "problems")).toEqual([
			{ kind: "problems", notes: ["personas/ana.md"], detail: { problems: ["missing required field «description»"] } },
			{ kind: "problems", notes: ["personas/luis.md"], detail: { problems: ["superseded by [[ana]] but not in the archive (archivo/)"] } },
		]);
		// gimnasio is linked from two notes: a missing page, not two broken links.
		expect(ofKind(r.items, "broken_link")).toEqual([{ kind: "broken_link", notes: ["temas/universidad.md"], detail: { target: "cafeteria", line: 11 } }]);
		expect(ofKind(r.items, "missing_page")).toEqual([{ kind: "missing_page", notes: ["temas/universidad.md", "yo/perfil.md"], detail: { target: "gimnasio", notes: 2, links: 2 } }]);
		expect(ofKind(r.items, "duplicate_candidates")).toEqual([{ kind: "duplicate_candidates", notes: ["temas/universidad.md", "temas/universidades.md"], detail: { labels: ["universidad", "universidades"] } }]);

		const inferences = ofKind(r.items, "old_inference");
		expect(inferences).toHaveLength(1); // the recent one and the stated one are not reported; the undated one is recent
		expect(inferences[0]).toMatchObject({ notes: ["yo/perfil.md"], detail: { line: 12, section: "Gustos", date: "2020-01-10", snippet: "Prefiere estudiar de noche" } });

		const mentions = ofKind(r.items, "unlinked_mention");
		expect(mentions).toContainEqual({
			kind: "unlinked_mention",
			notes: ["temas/universidad.md", "temas/piso-de-oviedo.md"],
			detail: { label: "piso de oviedo", line: 9, mentions: 2, snippet: "Cinco asignaturas. Queda cerca del Piso de Oviedo, y del piso de oviedo otra vez." },
		});
		expect(mentions).toContainEqual(expect.objectContaining({ notes: ["temas/huerto.md", "yo/perfil.md"], detail: expect.objectContaining({ label: "alex" }) }));
		// Already linked (perfil → universidad), inside code, or too short ("yo"): not mentions.
		expect(mentions.map((m) => m.notes.join(" "))).toEqual(["temas/universidad.md temas/piso-de-oviedo.md", "temas/huerto.md yo/perfil.md"]);

		// yo/ is listed in index_full, so its notes are never orphans by default.
		expect(ofKind(r.items, "orphan").map((i) => i.notes[0])).toEqual(["personas/luis.md", "temas/huerto.md", "temas/universidades.md"]);
		expect(ofKind(r.items, "stale")).toEqual([]);
		expect(ofKind(r.items, "oversized")).toEqual([]);
		expect(r.counts).toEqual({ problems: 2, broken_link: 1, duplicate_candidates: 1, old_inference: 1, missing_page: 1, unlinked_mention: 2, orphan: 3, stale: 0, oversized: 0 });
	});

	it("dates staleness and undated inferences from git", async () => {
		env = await makeMemory(SEED);
		const r = env.memory.lint({ kinds: ["stale", "old_inference"], limit: 500 }, Date.now() + 200 * DAY);
		expect(ofKind(r.items, "stale").map((i) => i.notes[0]).sort()).toEqual(
			["personas/ana.md", "personas/luis.md", "temas/huerto.md", "temas/piso-de-oviedo.md", "temas/universidad.md", "temas/universidades.md", "yo/perfil.md"].sort(),
		);
		expect(ofKind(r.items, "stale")[0]?.detail).toMatchObject({ updated_at: isoDate, days: expect.any(Number) });
		expect(ofKind(env.memory.lint({ kinds: ["stale"] }, Date.now() + 170 * DAY).items, "stale")).toEqual([]);
		const inferences = ofKind(env.memory.lint({ kinds: ["old_inference"] }, Date.now() + 100 * DAY).items, "old_inference");
		// Oldest first: the 2020 one, the one from 30 days ago (now 130), then the undated one (as old as its note).
		expect(inferences.map((i) => i.detail.date)).toEqual(["2020-01-10", recent, null]);
		expect(inferences[2]).toMatchObject({ notes: ["temas/piso-de-oviedo.md"], detail: { snippet: "La hipoteca vence en 2040", unchanged_since: isoDate } });
	});

	it("filters by kind and folder and limits the output", async () => {
		env = await makeMemory(SEED);
		const r = env.memory.lint({ kinds: ["orphan", "problems"], folder: "personas" });
		expect(r.counts).toEqual({ problems: 2, orphan: 1 });
		expect(r.items.every((i) => i.notes.some((p) => p.startsWith("personas/")))).toBe(true);
		const one = env.memory.lint({ limit: 1 });
		expect(one.items).toHaveLength(1);
		expect(one.truncated).toBe(true);
		expect(one.total).toBeGreaterThan(1);
		expect(() => env!.memory.lint({ kinds: ["nope"] })).toThrow(/Unknown lint kinds/);
	});

	it("takes its thresholds, markers and exclusions from memory.toml", async () => {
		const conventions = `${CONVENTIONS}
[lint]
exclude = ["personas"]
orphan_exclude = ["temas"]
stale_days = 10
inference_days = 5
inferred_markers = ["inferido", "supuesto"]
max_bytes = 500
missing_page_min = 3
mention_min_length = 5
`;
		env = await makeMemory({
			...SEED,
			"memory.toml": conventions,
			"yo/salud.md": note("Salud", "Médicos", `Alergia al polen (inferido, ${new Date(Date.now() - 8 * DAY).toISOString().slice(0, 10)}).\nDuerme poco (supuesto).`),
		});
		const r = env.memory.lint({ limit: 500 });
		expect(r.thresholds).toEqual({ stale_days: 10, inference_days: 5, max_bytes: 500, missing_page_min: 3 });
		expect(r.items.some((i) => i.notes.some((p) => p.startsWith("personas/")))).toBe(false);
		// gimnasio (2 notes) is now below missing_page_min, so each link is a broken link.
		expect(ofKind(r.items, "missing_page")).toEqual([]);
		expect(ofKind(r.items, "broken_link").map((i) => i.detail.target).sort()).toEqual(["cafeteria", "gimnasio", "gimnasio"]);
		// Only the configured markers count: «deducido» is no longer one.
		expect(ofKind(r.items, "old_inference")).toEqual([expect.objectContaining({ notes: ["yo/salud.md"], detail: expect.objectContaining({ snippet: "Alergia al polen" }) })]);
		expect(ofKind(r.items, "oversized")).toEqual([{ kind: "oversized", notes: ["temas/huerto.md"], detail: { bytes: expect.any(Number), sections: 1 } }]);
		// temas/ is exempt from orphans now, yo/ no longer is.
		expect(ofKind(r.items, "orphan").map((i) => i.notes[0])).toEqual(["yo/salud.md"]);
		// "alex" is shorter than mention_min_length.
		expect(ofKind(r.items, "unlinked_mention").map((i) => i.detail.label)).toEqual(["piso de oviedo"]);
		expect(ofKind(env.memory.lint({ kinds: ["stale"] }, Date.now() + 11 * DAY).items, "stale").length).toBeGreaterThan(0);
	});

	it("runs over a few thousand notes in well under a second", { timeout: 180_000 }, async () => {
		// Built straight into an index (no git): the point is the cost of lint itself.
		const conventions = parseConventions(CONVENTIONS);
		const index = new SearchIndex(join(await tempDir(), "index.sqlite"));
		let seed = 11;
		const rand = (n: number) => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return Math.floor(((seed >>> 0) / 2 ** 32) * n);
		};
		const word = () => Array.from({ length: 5 + rand(5) }, () => "abcdefghijklmnopqrstuvwxyz"[rand(26)]).join("");
		const n = 3000;
		const names = Array.from({ length: n }, (_, i) => `${word()}-${word()}-${i}`);
		index.db.exec("BEGIN");
		for (let i = 0; i < n; i++) {
			const name = names[i] as string;
			const other = (names[rand(n)] as string).replace(/-/g, " ");
			const body = `Sobre ${word()} y ${word()}. Ver [[${names[rand(n)]}]] y [[falta-${rand(4000)}]], y también ${other}.\n\n## Detalles\n\n${"Texto de relleno con palabras. ".repeat(10)}Le gusta ${word()} (deducido, 2021-05-0${(i % 9) + 1}).\n`;
			const content = note(name.replace(/-/g, " "), `Nota sobre ${word()}`, body, `aliases: ["${word()} ${word()}"]\n`);
			const parsed = parseNote(content, conventions);
			const path = `temas/${name}.md`;
			const title = name.replace(/-/g, " ");
			index.putNote(
				{ path, name, folder: "temas", title, description: parsed.meta.description, aliases: parsed.meta.aliases, archived: false, supersededBy: null, attachment: null, blobHash: blobHash(content), size: content.length, problems: [] },
				splitSections(parsed.body, parsed.bodyLine, title),
				parseTypedLinks(content),
			);
			index.setDates(path, { updatedAt: "2025-01-01T00:00:00Z", updatedBy: "x" });
		}
		index.resolveLinks();
		index.db.exec("COMMIT");
		try {
			// Best of three, so a busy test machine does not make it flaky.
			let ms = Number.POSITIVE_INFINITY;
			let r = lint(index, conventions, { limit: 500 }, Date.parse("2026-10-18"));
			for (let run = 0; run < 3; run++) {
				const started = performance.now();
				r = lint(index, conventions, { limit: 500 }, Date.parse("2026-10-18"));
				ms = Math.min(ms, performance.now() - started);
			}
			expect(r.counts.broken_link).toBeGreaterThan(0);
			expect(r.counts.unlinked_mention).toBeGreaterThan(0);
			expect(r.counts.old_inference).toBe(n);
			expect(r.counts.stale).toBe(n);
			expect(ms).toBeLessThan(1000);
		} finally {
			index.close();
		}
	});
});

describe("lint conventions", () => {
	it("defaults orphan_exclude to index_full and validates the [lint] table", () => {
		expect(defaultConventions().lint).toMatchObject({ staleDays: 180, inferenceDays: 90, inferredMarkers: ["deducido"], exclude: [], orphanExclude: [] });
		expect(parseConventions(CONVENTIONS).lint.orphanExclude).toEqual(["yo"]);
		expect(parseConventions(`${CONVENTIONS}\n[lint]\norphan_exclude = []\n`).lint.orphanExclude).toEqual([]);
		expect(() => parseConventions("[lint]\nstale_days = 0\n")).toThrow(/stale_days/);
		expect(() => parseConventions("[lint]\ninferred_markers = [\"a(b\"]\n")).toThrow(/inferred_markers/);
		expect(() => parseConventions("[lint]\nexclude = \"temas\"\n")).toThrow(/lint.exclude/);
	});
});

describe("lookAlikePairs", () => {
	it("finds exactly the pairs that comparing everything with looksLikeSame finds", () => {
		const base = ["universidad", "universidades", "piso de oviedo", "piso de toledo", "piso oviedo", "casa", "cosa", "kasa", "receta de lentejas", "lentejas", "recetas de lentejas", "ab", "a", "x", "abc", "banco santander", "santander", "coche", "coches", "médico", "medico de cabecera", "ana", "ana maría", "maría"];
		let seed = 7;
		const rand = () => {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return (seed >>> 0) / 2 ** 32;
		};
		const mutate = (s: string) => {
			const i = Math.floor(rand() * s.length);
			const op = rand();
			return op < 0.33 ? s.slice(0, i) + s.slice(i + 1) : op < 0.66 ? `${s.slice(0, i)}e${s.slice(i)}` : `${s.slice(0, i)}o${s.slice(i + 1)}`;
		};
		const items = Array.from({ length: 120 }, (_, i) => {
			const a = base[Math.floor(rand() * base.length)] as string;
			return { item: i, labels: rand() < 0.5 ? [mutate(a)] : [a, mutate(mutate(a))] };
		});
		const brute = new Set<string>();
		for (let i = 0; i < items.length; i++)
			for (let j = i + 1; j < items.length; j++) {
				if (items[i]!.labels.some((x) => items[j]!.labels.some((y) => looksLikeSame(x, y)))) brute.add(`${i}:${j}`);
			}
		const fast = new Set(lookAlikePairs(items).map((p) => `${p.a}:${p.b}`));
		expect(fast).toEqual(brute);
		expect(brute.size).toBeGreaterThan(50);
	});
});

function order(kind: string): number {
	return ["problems", "broken_link", "duplicate_candidates", "old_inference", "missing_page", "unlinked_mention", "orphan", "stale", "oversized"].indexOf(kind);
}
