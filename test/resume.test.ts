import { afterEach, describe, expect, it } from "vitest";
import { CONVENTIONS, makeMemory, note, writer } from "./helpers.js";

const TFG = note(
	"TFG",
	"Trabajo de fin de grado sobre redes neuronales",
	"Dirigido por Marta.\n\n## Estado\n\nCapítulo 2 escrito; falta revisar las figuras.\n\n### Bloqueos\n\nEsperando los datos del laboratorio.\n\n## Siguientes pasos\n\n- Rehacer la figura 3\n- Enviar a Marta el viernes\n\n## Bibliografía\n\nMuchas referencias largas que no hace falta leer para seguir.\n\n## Historia\n\nEmpezado en marzo.\n",
);

let env: Awaited<ReturnType<typeof makeMemory>> | null = null;
afterEach(async () => {
	await env?.cleanup();
	env = null;
});

const conventions = `${CONVENTIONS}\n[resume]\nsections = ["Estado", "Siguientes pasos"]\n`;

describe("resume", () => {
	it("gives the state sections whole and only the headings of the rest", async () => {
		env = await makeMemory({ "memory.toml": conventions, "proyectos/tfg.md": TFG });
		const r = await env.memory.resume({ topic: "tfg" });
		expect(r.path).toBe("proyectos/tfg.md");
		expect(r.description).toBe("Trabajo de fin de grado sobre redes neuronales");
		expect(r.state?.map((s) => s.heading)).toEqual(["Estado", "Bloqueos", "Siguientes pasos"]); // a subsection goes with its section
		expect(r.state?.[2]?.text).toContain("Enviar a Marta el viernes");
		expect(r.other_sections).toEqual(["Bibliografía", "Historia"]);
		expect(JSON.stringify(r)).not.toContain("referencias largas");
		expect(r.changes).toHaveLength(1);
		expect(r.hash).toMatch(/^[0-9a-f]{40}$/);
	});

	it("finds the topic from words, and offers other candidates", async () => {
		env = await makeMemory({ "memory.toml": conventions, "proyectos/tfg.md": TFG, "temas/redes.md": note("Redes", "Redes neuronales en general", "Apuntes de redes neuronales.") });
		const r = await env.memory.resume({ topic: "neuronales" });
		expect([r.path, ...(r.other_candidates ?? []).map((c) => c.path)].sort()).toEqual(["proyectos/tfg.md", "temas/redes.md"]);
	});

	it("says what changed since the last visit", async () => {
		env = await makeMemory({ "memory.toml": conventions, "proyectos/tfg.md": TFG });
		const before = new Date(Date.now() - 1000).toISOString();
		expect((await env.memory.resume({ topic: "tfg", since: new Date(Date.now() + 60_000).toISOString() })).changed).toBe(false);
		await env.memory.edit(writer, { name: "tfg", edits: [{ old_string: "Rehacer la figura 3", new_string: "Figura 3 rehecha" }], reason: "Figura 3 terminada" });
		const r = await env.memory.resume({ topic: "tfg", since: before });
		expect(r.changed).toBe(true);
		expect(r.changes.map((c) => c.why)).toEqual(["Figura 3 terminada"]);
		expect(r.state?.[2]?.text).toContain("Figura 3 rehecha");
	});

	it("without state sections, gives the beginning and says to add them", async () => {
		env = await makeMemory({ "memory.toml": conventions, "temas/redes.md": note("Redes", "Redes neuronales", "Apuntes de redes neuronales.\n\n## Tipos\n\nCNN, RNN.") });
		const r = await env.memory.resume({ topic: "redes" });
		expect(r.state).toBeUndefined();
		expect(r.intro).toContain("Apuntes de redes neuronales.");
		expect(r.note).toContain("Estado, Siguientes pasos");
		expect(r.other_sections).toEqual(["Tipos"]);
	});
});
