import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { DriveFiles, FileContent } from "./drive-files.js";
import { MemoryError } from "./errors.js";
import { type Logger, silentLogger } from "./log.js";
import type { ClientIdentity, MemoryService } from "./memory.js";
import { type DriveSources, emptySources, MAX_ATTEMPTS, type SourceTask, type SourcesState } from "./sources.js";

/**
 * Which agent reads each new or changed source and updates the memory. Pick one:
 *
 * - `anthropic`: Claude through the Anthropic API (reads PDFs and images directly).
 * - `openai`: any OpenAI-compatible chat completions API (OpenAI, OpenRouter, a local model…); text sources only.
 * - `webhook`: hands each source to another program (for example an agent platform of your own), which then
 *   updates the memory through this MCP server like any other agent.
 */
export interface IngestConfig {
	provider: "anthropic" | "openai" | "webhook";
	/** Model id, for anthropic and openai. Default claude-opus-5-5 for anthropic. */
	model?: string;
	apiKey?: string;
	/** API base: an OpenAI-compatible one (required for openai), or a proxy for Anthropic. */
	baseUrl?: string;
	webhookUrl?: string;
	webhookSecret?: string;
	/** Sources handled per run (the rest wait for the next one). Default 3. */
	maxFilesPerRun?: number;
	/** Tool calls per source. Default 30. */
	maxSteps?: number;
	/** Characters of a text source given to the agent. Default 200000. */
	maxChars?: number;
}

export interface IngestOutcome {
	summary: string;
	notes: string[];
	delegated?: boolean;
}

export interface IngestReport {
	skipped?: "running";
	done: { id: string; name: string; kind: SourceTask["kind"]; notes: string[]; summary: string }[];
	failed: { id: string; name: string; error: string }[];
	remaining: number;
}

/** One agent that integrates one source into the memory. */
export interface IngestAgent {
	readonly name: string;
	handle(task: SourceTask, content: FileContent | null): Promise<IngestOutcome>;
}

/** What the ingestion agent is told, besides the memory's own rules and index. */
export function ingestBrief(task: SourceTask): string {
	const cite = `source:${task.id}`;
	const what =
		task.kind === "removed"
			? `The document «${task.name}» (${task.path}, ${cite}) was removed from the sources folder. Find the notes that cite ${cite} (search for it) and say there that the document is no longer available, keeping what the notes learned from it.`
			: task.kind === "changed"
				? `A new version of the document «${task.name}» (${task.path}, ${cite}) is in the sources folder; it is attached below. Bring the memory up to date with what changed, in the notes that already cite ${cite} (search for it) and wherever else it belongs.`
				: `A new document, «${task.name}» (${task.path}, ${cite}), was added to the sources folder; it is attached below. Integrate what it says into the memory.`;
	return [
		"You are the ingestion agent of this memory: the user drops documents into a sources folder and you keep the memory up to date with them, on your own (nobody will answer questions).",
		what,
		`How: search first, read the notes it belongs to, and change them with edit (or write); create a note only when none fits, following the memory's rules and folders. Every note you change must cite the document as ${cite} where the rules put sources. Take only what the document says; mark anything you infer as the rules say. Do not copy the whole document: the memory keeps what matters, and the document stays where it is.`,
		"Give every write a short reason in the language of the memory. When you are done, answer with one or two lines saying what you changed.",
	].join("\n\n");
}

type ToolSpec = { name: string; description: string; schema: Record<string, unknown> & { type: "object" }; run: (args: Record<string, unknown>) => Promise<unknown> };

/** The memory tools the ingestion agent can use, run in-process as the ingestion client. */
export function memoryTools(memory: MemoryService, client: ClientIdentity, touched: Set<string>): ToolSpec[] {
	const ref = { path: { type: "string", description: "Repo-relative path of the note." }, name: { type: "string", description: "Note name (file name without .md)." } };
	const wrote = (r: { path: string }) => {
		touched.add(r.path);
		return r;
	};
	return [
		{ name: "search", description: "Full-text search of the notes; returns the best sections with a snippet.", schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] }, run: async (a) => memory.searchAny(a as { query: string; limit?: number }) },
		{ name: "list", description: "Without folder: the index of the memory. With folder: its notes.", schema: { type: "object", properties: { folder: { type: "string" } } }, run: async (a) => memory.list(a as { folder?: string }) },
		{ name: "read", description: "A note (or one section) with its hash, needed to write it.", schema: { type: "object", properties: { ...ref, section: { type: "string" } } }, run: async (a) => memory.read(a as { path?: string; name?: string; section?: string }) },
		{ name: "links", description: "Links out of a note and backlinks into it.", schema: { type: "object", properties: ref }, run: async (a) => memory.links(a as { path?: string; name?: string }) },
		{
			name: "create",
			description: "Create a note (full Markdown with frontmatter). Fails with DUPLICATE_CANDIDATES if similar notes exist: read them; pass confirm_new only if it really is new.",
			schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, reason: { type: "string" }, confirm_new: { type: "boolean" } }, required: ["path", "content", "reason"] },
			run: async (a) => wrote(await memory.create(client, a as { path: string; content: string; reason: string; confirm_new?: boolean })),
		},
		{
			name: "edit",
			description: "Exact text replacements in a note, applied in order. Each old_string must appear exactly once (or set replace_all).",
			schema: {
				type: "object",
				properties: { ...ref, reason: { type: "string" }, hash: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["old_string", "new_string"] } } },
				required: ["edits", "reason"],
			},
			run: async (a) => wrote(await memory.edit(client, a as unknown as Parameters<MemoryService["edit"]>[1])),
		},
		{
			name: "write",
			description: "Replace a whole note; needs the hash from read.",
			schema: { type: "object", properties: { ...ref, content: { type: "string" }, hash: { type: "string" }, reason: { type: "string" } }, required: ["content", "hash", "reason"] },
			run: async (a) => wrote(await memory.write(client, a as unknown as Parameters<MemoryService["write"]>[1])),
		},
	];
}

/** A tool's result as text for the model; errors come back as data so the agent can recover. */
async function runTool(tool: ToolSpec, args: Record<string, unknown>): Promise<string> {
	try {
		return JSON.stringify(await tool.run(args ?? {}));
	} catch (error) {
		if (error instanceof MemoryError) return JSON.stringify({ error: error.toJSON() });
		return JSON.stringify({ error: { code: "INTERNAL", message: (error as Error).message } });
	}
}

const IMAGE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Claude, with the SDK's tool runner. Sources go as text, PDF documents or images. */
export class AnthropicAgent implements IngestAgent {
	readonly name: string;
	private readonly client: Anthropic;

	constructor(
		private readonly memory: MemoryService,
		private readonly config: IngestConfig,
	) {
		this.client = new Anthropic({ apiKey: config.apiKey, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });
		this.name = config.model ?? "claude-opus-5-5";
	}

	async handle(task: SourceTask, content: FileContent | null): Promise<IngestOutcome> {
		const touched = new Set<string>();
		const client: ClientIdentity = { id: "ingest", name: `Ingestion (${this.name})`, scope: "write" };
		const blocks: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: ingestBrief(task) }];
		if (content?.kind === "text") blocks.push({ type: "text", text: `<document name="${task.name}" id="${task.id}">\n${content.text}\n</document>${content.truncated ? "\n(The document was cut here.)" : ""}` });
		else if (content?.kind === "binary" && content.mimeType === "application/pdf") blocks.push({ type: "document", title: task.name, source: { type: "base64", media_type: "application/pdf", data: content.data.toString("base64") } });
		else if (content?.kind === "binary" && IMAGE.has(content.mimeType)) blocks.push({ type: "image", source: { type: "base64", media_type: content.mimeType as "image/png", data: content.data.toString("base64") } });
		else if (content?.kind === "binary") throw new Error(`Files of type ${content.mimeType} cannot be read by the ingestion agent.`);
		const tools = memoryTools(this.memory, client, touched).map((t) =>
			betaTool({ name: t.name, description: t.description, inputSchema: t.schema as { type: "object" }, run: (args) => runTool(t, args as Record<string, unknown>) }),
		);
		const final = await this.client.beta.messages.toolRunner({
			model: this.name,
			max_tokens: 16_000,
			thinking: { type: "adaptive" },
			system: await this.memory.instructions(),
			messages: [{ role: "user", content: blocks }],
			tools,
			max_iterations: this.config.maxSteps ?? 30,
		});
		const summary = final.content
			.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		return { summary: summary.slice(0, 1000), notes: [...touched] };
	}
}

type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]; tool_call_id?: string };

/** Any OpenAI-compatible chat completions API, with function calling. Text sources only. */
export class OpenAICompatibleAgent implements IngestAgent {
	readonly name: string;

	constructor(
		private readonly memory: MemoryService,
		private readonly config: IngestConfig,
	) {
		if (!config.baseUrl) throw new Error("ingest.base_url is required for the openai provider");
		if (!config.model) throw new Error("ingest.model is required for the openai provider");
		this.name = config.model;
	}

	async handle(task: SourceTask, content: FileContent | null): Promise<IngestOutcome> {
		if (content?.kind === "binary") throw new Error(`This provider reads text only; «${task.name}» is ${content.mimeType}.`);
		const touched = new Set<string>();
		const client: ClientIdentity = { id: "ingest", name: `Ingestion (${this.name})`, scope: "write" };
		const tools = memoryTools(this.memory, client, touched);
		const messages: ChatMessage[] = [
			{ role: "system", content: await this.memory.instructions() },
			{ role: "user", content: `${ingestBrief(task)}${content ? `\n\n<document name="${task.name}" id="${task.id}">\n${content.text}\n</document>` : ""}` },
		];
		const url = `${(this.config.baseUrl as string).replace(/\/+$/, "")}/chat/completions`;
		for (let step = 0; step < (this.config.maxSteps ?? 30); step++) {
			const r = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
				body: JSON.stringify({ model: this.name, messages, tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })) }),
				signal: AbortSignal.timeout(180_000),
			});
			if (!r.ok) throw new Error(`The model API answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
			const reply = ((await r.json()) as { choices: { message: ChatMessage }[] }).choices[0]?.message;
			if (!reply) throw new Error("The model API gave no answer.");
			messages.push({ role: "assistant", content: reply.content ?? null, ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls } : {}) });
			if (!reply.tool_calls?.length) return { summary: (reply.content ?? "").trim().slice(0, 1000), notes: [...touched] };
			for (const call of reply.tool_calls) {
				const tool = tools.find((t) => t.name === call.function.name);
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(call.function.arguments || "{}");
				} catch {}
				messages.push({ role: "tool", tool_call_id: call.id, content: tool ? await runTool(tool, args) : JSON.stringify({ error: { code: "UNKNOWN_TOOL" } }) });
			}
		}
		return { summary: "Stopped at the step limit.", notes: [...touched] };
	}
}

/** Hands each source to another program, which updates the memory through MCP on its own. */
export class WebhookAgent implements IngestAgent {
	readonly name = "webhook";

	constructor(private readonly config: IngestConfig) {
		if (!config.webhookUrl) throw new Error("ingest.webhook_url is required for the webhook provider");
	}

	async handle(task: SourceTask): Promise<IngestOutcome> {
		const r = await fetch(this.config.webhookUrl as string, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(this.config.webhookSecret ? { Authorization: `Bearer ${this.config.webhookSecret}` } : {}) },
			body: JSON.stringify({ event: "source", kind: task.kind, id: task.id, cite: `source:${task.id}`, name: task.name, path: task.path, version: task.version, mime_type: task.mimeType, brief: ingestBrief(task) }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!r.ok) throw new Error(`The webhook answered ${r.status}.`);
		return { summary: "Handed to the webhook.", notes: [], delegated: true };
	}
}

export function createIngestAgent(memory: MemoryService, config: IngestConfig): IngestAgent {
	if (config.provider === "anthropic") return new AnthropicAgent(memory, config);
	if (config.provider === "openai") return new OpenAICompatibleAgent(memory, config);
	return new WebhookAgent(config);
}

const STATE_CLIENT: ClientIdentity = { id: "ingest", name: "Ingestion", scope: "write" };
const LEASE_MS = 10 * 60_000;

/**
 * Keeps the memory up to date with the sources folder: each run compares the folder with `.my-memory/sources.json`
 * (what was integrated, at which version) and has the agent handle what is new, changed or gone, a few at a time.
 * Comparing with the state, rather than trusting each change notice, means nothing is lost when a notice is.
 *
 * The state is saved after each source, so a run cut short (a serverless time limit) loses at most the source it
 * was on. With `lease` (for hosts that run several copies at once), a run first takes a lease in the same file;
 * the store only lets one copy commit it, so two notices for the same upload never ingest it twice.
 */
export class Ingester {
	private running = false;
	private readonly log: Logger;
	private readonly instance = Math.random().toString(36).slice(2, 10);

	constructor(
		private readonly memory: MemoryService,
		private readonly files: DriveFiles,
		private readonly sources: DriveSources,
		private readonly agent: IngestAgent,
		private readonly config: IngestConfig,
		private readonly opts: { log?: Logger; lease?: boolean } = {},
	) {
		this.log = opts.log ?? silentLogger;
	}

	/** Whether any of these changed Drive files is (or was) a source; cheap, for deciding to run. */
	async concerns(ids: string[]): Promise<boolean> {
		return this.sources.touches(ids, await this.memory.readState<SourcesState>("sources"));
	}

	async run(trigger: string): Promise<IngestReport> {
		if (this.running) return { skipped: "running", done: [], failed: [], remaining: 0 };
		this.running = true;
		try {
			// Several copies share the state only through the remote: start from its latest version.
			if (this.opts.lease) await this.memory.sync("ingest");
			await this.files.refresh();
			const state = (await this.memory.readState<SourcesState>("sources")) ?? emptySources();
			const tasks = this.sources.pending(state);
			const batch = tasks.slice(0, Math.max(1, this.config.maxFilesPerRun ?? 3));
			const report: IngestReport = { done: [], failed: [], remaining: tasks.length - batch.length };
			if (batch.length === 0) return report;
			if (this.opts.lease && !(await this.takeLease(state))) return { ...report, skipped: "running", remaining: tasks.length };
			for (const [i, task] of batch.entries()) {
				await this.handleOne(task, state, report, trigger);
				if (i === batch.length - 1) delete state.lease;
				const reason = `Ingestion: ${task.kind} «${task.name}»${report.failed.some((f) => f.id === task.id) ? " (failed)" : ""}`;
				await this.memory.saveState(STATE_CLIENT, "sources", state, reason);
			}
			return report;
		} finally {
			this.running = false;
		}
	}

	private async handleOne(task: SourceTask, state: SourcesState, report: IngestReport, trigger: string): Promise<void> {
		const previous = state.files[task.id];
		if (task.kind === "removed" && !previous?.ingested) {
			delete state.files[task.id]; // never made it into the memory: nothing to say
			return;
		}
		try {
			const content = task.kind === "removed" ? null : await this.files.read(task.id, { maxChars: this.config.maxChars ?? 200_000 });
			const out = await this.agent.handle(task, content);
			if (task.kind === "removed") delete state.files[task.id];
			else state.files[task.id] = { name: task.name, path: task.path, version: task.version as string, status: out.delegated ? "delegated" : "ingested", ingested: true, at: new Date().toISOString(), notes: out.notes, summary: out.summary };
			report.done.push({ id: task.id, name: task.name, kind: task.kind, notes: out.notes, summary: out.summary });
			this.log("info", "ingest.done", { trigger, source: task.id, kind: task.kind, notes: out.notes.length, agent: this.agent.name });
		} catch (error) {
			const message = (error as Error).message.slice(0, 300);
			const sameVersion = previous?.status === "failed" && (task.kind === "removed" || previous.version === task.version);
			const attempts = (sameVersion ? (previous.attempts ?? 1) : 0) + 1;
			state.files[task.id] = { ...(previous ?? {}), name: task.name, path: task.path, version: task.version ?? previous?.version ?? "", status: "failed", at: new Date().toISOString(), error: message, attempts };
			if (task.kind === "removed" && attempts >= MAX_ATTEMPTS) delete state.files[task.id]; // give up on saying it is gone
			report.failed.push({ id: task.id, name: task.name, error: message });
			this.log("warn", "ingest.failed", { trigger, source: task.id, error: message, attempts, gives_up: attempts >= MAX_ATTEMPTS });
		}
	}

	/** Commits a lease into the state; false when another copy holds one or committed first. */
	private async takeLease(state: SourcesState): Promise<boolean> {
		const now = Date.now();
		if (state.lease && state.lease.by !== this.instance && Date.parse(state.lease.until) > now) return false;
		state.lease = { by: this.instance, until: new Date(now + LEASE_MS).toISOString() };
		try {
			await this.memory.saveState(STATE_CLIENT, "sources", state, "Ingestion: started");
			return true;
		} catch (error) {
			if (error instanceof MemoryError && error.code === "REMOTE_CONFLICT") return false;
			throw error;
		}
	}
}
