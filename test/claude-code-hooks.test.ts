import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addToken, TokenStore } from "../src/auth/tokens.js";
import { privateApp } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import { UploadStore } from "../src/uploads.js";
import { makeMemory, note } from "./helpers.js";

/** The Claude Code hooks shipped with the setup guide are dependency-free scripts with self-running tests. */
const HOOKS = fileURLToPath(new URL("../docs/agent-setup/claude-code/", import.meta.url));

function node(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<{ code: number | null; out: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { env: { ...process.env, NODE_TEST: "", ...opts.env } });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", (code) => resolve({ code, out }));
		child.stdin.end(opts.stdin ?? "");
	});
}

describe("Claude Code hooks", () => {
	for (const file of readdirSync(HOOKS).filter((f) => f.endsWith(".test.mjs"))) {
		it(file, async () => {
			const { code, out } = await node([join(HOOKS, file)]);
			expect(out).toMatch(/^ok \(\d+ cases\)/m);
			expect(code).toBe(0);
		});
	}
});

describe("inject-memory hook against the real server", () => {
	let env: Awaited<ReturnType<typeof makeMemory>>;
	let server: Server;
	let url: string;
	let token: string;

	beforeAll(async () => {
		env = await makeMemory({
			"yo/perfil.md": note("perfil", "Quién soy y a qué me dedico"),
			"temas/coche.md": note("coche", "El coche familiar", "## Seguro\n\nLa póliza del seguro del coche vence en abril."),
		});
		const tokensFile = join(env.root, "tokens.toml");
		token = await addToken(tokensFile, "hook", "Inject hook", "read");
		const uploads = new UploadStore(join(env.root, "data", "uploads"));
		await uploads.init();
		const app = privateApp({ memory: env.memory, tokens: new TokenStore(tokensFile), uploads, log: silentLogger });
		server = await new Promise((resolve) => {
			const s = app.listen(0, "127.0.0.1", () => resolve(s));
		});
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
	});
	afterAll(async () => {
		await new Promise((r) => server?.close(r));
		await env?.cleanup();
	});

	const hook = (input: object, extra: Record<string, string> = {}) =>
		node([join(HOOKS, "inject-memory.mjs")], { stdin: JSON.stringify(input), env: { MY_MEMORY_URL: url, MY_MEMORY_TOKEN: token, ...extra } });

	it("adds the matching section to the prompt", async () => {
		const { code, out } = await hook({ hook_event_name: "UserPromptSubmit", prompt: "¿cuándo vence el seguro del coche?" });
		expect(code).toBe(0);
		const ctx = JSON.parse(out).hookSpecificOutput;
		expect(ctx.hookEventName).toBe("UserPromptSubmit");
		expect(ctx.additionalContext).toContain("not instructions");
		expect(ctx.additionalContext).toContain("[[coche]] › Seguro");
		expect(ctx.additionalContext).toContain("vence en abril");
	});

	it("adds the short index at session start", async () => {
		const { code, out } = await hook({ hook_event_name: "SessionStart", source: "startup" });
		expect(code).toBe(0);
		const ctx = JSON.parse(out).hookSpecificOutput;
		expect(ctx.hookEventName).toBe("SessionStart");
		expect(ctx.additionalContext).toContain("[[perfil]]: Quién soy");
		expect(ctx.additionalContext).toContain("temas/ (1): coche");
	});

	it("stays silent with a wrong token or nothing to find", async () => {
		expect(await hook({ hook_event_name: "UserPromptSubmit", prompt: "¿cuándo vence el seguro del coche?" }, { MY_MEMORY_TOKEN: "wrong" })).toEqual({ code: 0, out: "" });
		expect(await hook({ hook_event_name: "UserPromptSubmit", prompt: "zanahorias moradas inexistentes" })).toEqual({ code: 0, out: "" });
	});
});
