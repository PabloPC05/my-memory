import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addToken, TokenStore } from "../src/auth/tokens.js";
import { privateApp } from "../src/http.js";
import { silentLogger } from "../src/log.js";
import { SETUP_GUIDE_URI, SETUP_GUIDE_URL, setupGuide } from "../src/setup-guide.js";
import { UploadStore } from "../src/uploads.js";
import { makeMemory, note, tempDir } from "./helpers.js";

describe("setup guide", () => {
	it("is bundled and readable relative to the package", () => {
		const guide = setupGuide();
		expect(guide).toContain("# Set up my-memory for your agent");
	});

	it("returns null for a missing file", async () => {
		expect(setupGuide(join(await tempDir(), "nope.md"))).toBeNull();
	});

	it("ships in the npm package and the nix build", async () => {
		const { readFile } = await import("node:fs/promises");
		const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };
		expect(pkg.files).toContain("docs/agent-setup.md");
		expect(await readFile(new URL("../nix/package.nix", import.meta.url), "utf8")).toContain("../docs/agent-setup.md");
	});
});

describe("setup guide over MCP", () => {
	let env: Awaited<ReturnType<typeof makeMemory>>;
	let server: Server;
	let url: string;
	let token: string;

	beforeAll(async () => {
		env = await makeMemory({ "yo/perfil.md": note("Perfil", "Quién es") }, { noRemote: true });
		const tokensFile = join(env.root, "tokens.toml");
		token = await addToken(tokensFile, "sam-reader", "Sam (reader)", "read");
		const uploads = new UploadStore(join(env.root, "data", "uploads"));
		await uploads.init();
		const app = privateApp({ memory: env.memory, tokens: new TokenStore(tokensFile), uploads, log: silentLogger });
		server = await new Promise((resolve) => {
			const s = app.listen(0, "127.0.0.1", () => resolve(s));
		});
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(async () => {
		await new Promise((r) => server?.close(r));
		await env?.cleanup();
	});

	it("serves the guide as the `setup` prompt and as a resource, to any scope, and points to them in the instructions", async () => {
		const guide = setupGuide() as string;
		const client = new Client({ name: "test", version: "1" });
		await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
		const instructions = client.getInstructions() ?? "";
		expect(instructions).toContain("`setup` prompt");
		expect(instructions).toContain(SETUP_GUIDE_URI);
		expect(instructions).toContain(SETUP_GUIDE_URL);
		expect(instructions.indexOf("`setup` prompt")).toBeLessThan(instructions.indexOf("## Index"));

		const prompts = (await client.listPrompts()).prompts;
		expect(prompts.map((p) => p.name)).toEqual(["setup"]);
		expect(prompts[0]?.title).toBe("Set up this memory on your host");
		const prompt = await client.getPrompt({ name: "setup" });
		expect(prompt.messages[0]).toMatchObject({ role: "user", content: { type: "text", text: guide } });

		const resources = (await client.listResources()).resources;
		expect(resources.map((r) => r.uri)).toEqual([SETUP_GUIDE_URI]);
		const res = await client.readResource({ uri: SETUP_GUIDE_URI });
		expect(res.contents[0]).toMatchObject({ uri: SETUP_GUIDE_URI, mimeType: "text/markdown", text: guide });
		await client.close();
	});
});
