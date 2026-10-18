// node docs/agent-setup/claude-code/inject-memory.test.mjs
process.env.NODE_TEST = "1";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
const { searchQuery, formatHits, configFrom, run } = await import("./inject-memory.mjs");

let fail = 0;
let count = 0;
const check = (ok, what) => {
  count++;
  if (!ok) (fail++, console.log("FAIL:", what));
};

// --- Query building ---
const queries = [
  ["what did we decide about the car insurance renewal?", (q) => q.includes("car") && q.includes("insurance") && !/\bthe\b/.test(q)],
  ["¿qué quedó pendiente del proyecto de la universidad?", (q) => q.includes("proyecto") && q.includes("universidad") && !/\bdel\b/.test(q)],
  ["/compact", (q) => q === null],
  ["!git status --short", (q) => q === null],
  ["ok thanks", (q) => q === null],
  ["hola, ¿qué tal estás?", (q) => q === null],
];
for (const [prompt, ok] of queries) check(ok(searchQuery(prompt)), `searchQuery(${JSON.stringify(prompt)}) = ${JSON.stringify(searchQuery(prompt))}`);

// --- Formatting ---
const cfg = configFrom({ MY_MEMORY_URL: "http://127.0.0.1:1/mcp", MEMORY_SEARCH_TOOL: "memoria_search" });
check(cfg.readTool === "memoria_read", "read tool follows the search tool's prefix");
for (const [url, ok] of [
  ["https://memory.example.org/mcp", true],
  ["http://memory.example.org/mcp", false],
  ["http://192.168.1.10:8080/mcp", false],
  ["http://localhost:8080/mcp", true],
  ["http://127.0.0.1:8080/mcp", true],
  ["http://[::1]:8080/mcp", true],
  ["ftp://localhost/mcp", false],
  ["not a url", false],
]) check((configFrom({ MY_MEMORY_URL: url }).url !== null) === ok, `MY_MEMORY_URL ${url} ${ok ? "accepted" : "refused"}`);
const hits = Array.from({ length: 10 }, (_, i) => ({ name: `nota-${i}`, section: { heading: `Sección ${i}` }, snippet: `«seguro» del «coche» ${"x".repeat(400)}` }));
const text = formatHits({ mode: "all", hits }, cfg);
check(text.length <= cfg.budget, `budget respected (${text.length})`);
check(text.includes("not instructions") && text.includes("memoria_read"), "framed as information, names the read tool");
check(text.includes("[[nota-0]] › Sección 0") && !text.includes("[[nota-4]]"), "at most `limit` hits, with note and section");
check(!text.includes("«"), "highlight marks stripped");
check(formatHits({ mode: "any", hits: [{ name: "a", snippet: "solo «coche» aquí" }] }, cfg) === null, "weak 'any' hits dropped");
check(formatHits({ mode: "all", hits: [] }, cfg) === null, "no hits, nothing added");

// --- Fake MCP servers ---
const HIT = { mode: "all", hits: [{ path: "temas/coche.md", name: "coche", section: { heading: "Seguro" }, snippet: "El «seguro» del «coche» vence en abril" }] };
const INDEX = { index: { full: [{ folder: "yo", notes: [{ name: "perfil", description: "Quién soy" }] }], folders: [{ folder: "temas", count: 12, names: ["coche"], more: 11 }] } };
const toolResult = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

async function serve(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = body ? JSON.parse(body) : null;
    seen.push({ method: req.method, headers: req.headers, msg });
    await handler(req, res, msg);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, seen, close: () => (server.closeAllConnections(), new Promise((r) => server.close(r))) };
}
const json = (res, value, headers = {}) => (res.writeHead(200, { "content-type": "application/json", ...headers }), res.end(JSON.stringify(value)));
const answer = (msg) =>
  msg.method === "tools/call"
    ? { jsonrpc: "2.0", id: msg.id, result: toolResult(msg.params.name.endsWith("list") ? INDEX : HIT) }
    : { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } };
const prompt = (p) => ({ hook_event_name: "UserPromptSubmit", prompt: p });
const context = (out) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext : "");

// Stateless server (like my-memory): answers a bare tools/call with JSON, in one round trip.
{
  const s = await serve((req, res, msg) => json(res, answer(msg)));
  const env = { MY_MEMORY_URL: s.url, MY_MEMORY_TOKEN: "tok-1" };
  const out = await run(prompt("cuándo vence el seguro del coche"), env);
  check(JSON.parse(out || "{}").hookSpecificOutput?.hookEventName === "UserPromptSubmit", "stateless: UserPromptSubmit output");
  check(context(out).includes("[[coche]] › Seguro: El seguro del coche vence en abril"), "stateless: hit injected");
  check(s.seen.length === 1 && s.seen[0].msg.method === "tools/call" && s.seen[0].msg.params.name === "search", "stateless: one tools/call to search");
  check(s.seen[0].headers.authorization === "Bearer tok-1", "stateless: bearer token sent");
  check(/seguro/.test(s.seen[0].msg.params.arguments.query) && !/\bdel\b/.test(s.seen[0].msg.params.arguments.query), "stateless: keyword query");
  const before = s.seen.length;
  check((await run(prompt("/review the last commit please"), env)) === "" && s.seen.length === before, "slash command: no request, no output");
  const start = await run({ hook_event_name: "SessionStart", source: "startup" }, env);
  check(JSON.parse(start || "{}").hookSpecificOutput?.hookEventName === "SessionStart", "SessionStart output");
  check(context(start).includes("[[perfil]]: Quién soy") && context(start).includes("temas/ (12): coche, and 11 more"), "SessionStart: short index");
  check(s.seen.at(-1).msg.params.name === "list", "SessionStart calls list");
  await s.close();
}

// Gateway: needs initialize, hands out a session id, answers with SSE, prefixed tool names.
{
  const s = await serve((req, res, msg) => {
    // A redirect is never followed, so the token does not go elsewhere: one DELETE only, below.
    if (req.method === "DELETE") return (res.writeHead(307, { location: "/elsewhere" }), res.end());
    if (msg.method === "initialize") return json(res, answer(msg), { "mcp-session-id": "sess-42" });
    if (req.headers["mcp-session-id"] !== "sess-42") return (res.writeHead(400, { "content-type": "application/json" }), res.end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"},"id":null}'));
    if (!msg.id) return (res.writeHead(202), res.end());
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": keep-alive\n\n");
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`);
    res.write(`event: message\ndata: ${JSON.stringify(answer(msg))}\n\n`);
    // Leave the stream open: the hook must not wait for it to end.
  });
  const env = { MY_MEMORY_URL: s.url, MY_MEMORY_TOKEN: "tok-2", MEMORY_SEARCH_TOOL: "memoria_search" };
  const out = await run(prompt("cuándo vence el seguro del coche"), env);
  check(context(out).includes("[[coche]] › Seguro") && context(out).includes("memoria_read"), "gateway: hit injected via session + SSE");
  const methods = s.seen.map((r) => r.msg?.method ?? r.method);
  check(JSON.stringify(methods) === JSON.stringify(["tools/call", "initialize", "notifications/initialized", "tools/call", "DELETE"]), `gateway: handshake sequence ${methods}`);
  check(s.seen[3].msg.params.name === "memoria_search" && s.seen[3].headers["mcp-protocol-version"] === "2025-06-18", "gateway: prefixed tool, protocol version header");
  check(s.seen.every((r) => r.headers.authorization === "Bearer tok-2"), "gateway: token on every request");
  await s.close();
}

// Failures are silent.
{
  const s = await serve((req, res) => (res.writeHead(500), res.end("boom")));
  check((await run(prompt("cuándo vence el seguro del coche"), { MY_MEMORY_URL: s.url })) === "", "HTTP 500: nothing");
  await s.close();
}
{
  const s = await serve((req, res, msg) => json(res, { jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "{}" }] } }));
  check((await run(prompt("cuándo vence el seguro del coche"), { MY_MEMORY_URL: s.url })) === "", "tool error: nothing");
  await s.close();
}
{
  const s = await serve(() => {}); // never answers
  const started = Date.now();
  const out = await run(prompt("cuándo vence el seguro del coche"), { MY_MEMORY_URL: s.url, MEMORY_INJECT_TIMEOUT_MS: "300" });
  check(out === "" && Date.now() - started < 2000, `timeout: nothing, quickly (${Date.now() - started} ms)`);
  await s.close();
}
check((await run(prompt("cuándo vence el seguro del coche"), {})) === "", "no URL: nothing");
check((await run(prompt("cuándo vence el seguro del coche"), { MY_MEMORY_URL: "file:///etc/passwd" })) === "", "non-http URL: nothing");
check((await run(prompt("cuándo vence el seguro del coche"), { MY_MEMORY_URL: "http://127.0.0.1:9/mcp" })) === "", "connection refused: nothing");

// As a real hook process: stdin in, JSON out, exit 0; garbage in, nothing out.
async function hook(stdin, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./inject-memory.mjs", import.meta.url))], { env: { ...process.env, NODE_TEST: "", ...env } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.end(stdin);
  const code = await new Promise((r) => child.on("close", r));
  return { code, out };
}
{
  const s = await serve((req, res, msg) => json(res, answer(msg)));
  const ok = await hook(JSON.stringify(prompt("cuándo vence el seguro del coche")), { MY_MEMORY_URL: s.url });
  check(ok.code === 0 && context(ok.out).includes("[[coche]]"), "process: injects and exits 0");
  const bad = await hook("not json", { MY_MEMORY_URL: s.url });
  check(bad.code === 0 && bad.out === "", "process: bad input, silent exit 0");
  await s.close();
}
{
  const s = await serve(() => {});
  const started = Date.now();
  const hung = await hook(JSON.stringify(prompt("cuándo vence el seguro del coche")), { MY_MEMORY_URL: s.url, MEMORY_INJECT_TIMEOUT_MS: "300" });
  check(hung.code === 0 && hung.out === "" && Date.now() - started < 5000, "process: hung server, silent exit 0");
  await s.close();
}

console.log(fail ? `${fail} failed` : `ok (${count} cases)`);
process.exit(fail ? 1 : 0);
