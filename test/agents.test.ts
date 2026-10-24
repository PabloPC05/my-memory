import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicAgent, OpenAICompatibleAgent } from "../src/ingest.js";
import type { SourceTask } from "../src/sources.js";
import { makeMemory } from "./helpers.js";
import { makePdf } from "./pdf.js";

const TASK: SourceTask = { kind: "added", id: "reunion", name: "Reunión.pdf", path: "Fuentes/Reunión.pdf", version: "1", mimeType: "application/pdf", previous: null };
const PDF = makePdf(["Marta pide el capitulo 3 antes del 15 de noviembre."]);

let server: Server | null = null;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
	await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
	await cleanup?.();
	server = null;
	cleanup = null;
});

async function serve(handler: (body: Record<string, unknown>, res: ServerResponse) => void): Promise<string> {
	server = createServer((req: IncomingMessage, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => handler(JSON.parse(raw || "{}"), res));
	});
	await new Promise<void>((ok) => (server as Server).listen(0, "127.0.0.1", ok));
	return `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`;
}

/** A Messages API answer as the SSE stream the SDK reads. */
function sse(res: ServerResponse, content: Record<string, unknown>[], stop: string) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
	content.forEach((block, index) => {
		if (block.type === "tool_use") {
			ev("content_block_start", { index, content_block: { ...block, input: {} } });
			ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
		} else {
			ev("content_block_start", { index, content_block: { type: "text", text: "" } });
			ev("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
		}
		ev("content_block_stop", { index });
	});
	ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
	ev("message_stop", {});
	res.end();
}

describe("ingestion agents", () => {
	it("anthropic: sends the whole conversation every turn, and the PDF as text when the API refuses documents", async () => {
		const env = await makeMemory();
		cleanup = env.cleanup;
		const requests: Record<string, unknown>[] = [];
		const url = await serve((body, res) => {
			requests.push(body);
			const messages = body.messages as { role: string; content: string | { type: string; text?: string }[] }[];
			const first = messages[0]?.content as { type: string; text?: string }[];
			if (first.some((b) => b.type === "document")) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid input at messages.0.content" } }));
				return;
			}
			if (messages.length === 1) sse(res, [{ type: "tool_use", id: "toolu_1", name: "search", input: { query: "tfg" } }], "tool_use");
			else sse(res, [{ type: "text", text: "Hecho: nada que cambiar." }], "end_turn");
		});
		const agent = new AnthropicAgent(env.memory, { provider: "anthropic", apiKey: "k", baseUrl: url, model: "m" });
		const out = await agent.handle(TASK, { kind: "binary", data: PDF, mimeType: "application/pdf", name: TASK.name });
		expect(out.summary).toBe("Hecho: nada que cambiar.");
		expect(requests).toHaveLength(3); // refused with the PDF, then two turns with its text
		const text = (requests[1]?.messages as { content: { text: string }[] }[])[0]?.content[0]?.text;
		expect(text).toContain("15 de noviembre");
		const last = requests[2]?.messages as { role: string; content: { type: string }[] }[];
		expect(last.map((m) => m.role)).toEqual(["user", "assistant", "user"]); // no server-side state
		expect(last[2]?.content[0]?.type).toBe("tool_result");
		expect(requests[2]?.thinking).toBeUndefined(); // off behind a base_url
	});

	it("openai: gets the PDF's text", async () => {
		const env = await makeMemory();
		cleanup = env.cleanup;
		let prompt = "";
		const url = await serve((body, res) => {
			prompt = (body.messages as { content: string }[])[1]?.content ?? "";
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hecho." } }] }));
		});
		const agent = new OpenAICompatibleAgent(env.memory, { provider: "openai", baseUrl: url, model: "m" });
		const out = await agent.handle(TASK, { kind: "binary", data: PDF, mimeType: "application/pdf", name: TASK.name });
		expect(out.summary).toBe("Hecho.");
		expect(prompt).toContain("[Page 1]");
		expect(prompt).toContain("15 de noviembre");
	});
});
