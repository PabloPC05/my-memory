import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MemoryError } from "./errors.js";
import type { Logger } from "./log.js";
import type { ClientIdentity, MemoryService } from "./memory.js";

export const SERVER_NAME = "my-memory";
export const SERVER_VERSION = "0.1.0";

const notePath = z.string().optional().describe("Repo-relative path, e.g. «temas/universidad.md». Give either path or name.");
const noteName = z.string().optional().describe("Note name (file name without .md), e.g. «universidad» or «[[universidad]]».");
const reason = z.string().describe("One line saying why, in the user's language. Becomes the commit message.");
const hash = z.string().describe("The `hash` returned by `read` for the version you are changing.");

function ok(result: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
	const e = error instanceof MemoryError ? error : new MemoryError("INTERNAL", "Internal error; the server log has the details.");
	return { isError: true, content: [{ type: "text", text: JSON.stringify(e.toJSON(), null, 2) }] };
}

/** A fresh MCP server per request (stateless transport), with the tools this client's scope allows. */
export async function createMcpServer(memory: MemoryService, client: ClientIdentity, log: Logger): Promise<McpServer> {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: await memory.instructions() });

	const wrap =
		<A extends Record<string, unknown>>(tool: string, fn: (args: A) => unknown) =>
		async (args: A): Promise<CallToolResult> => {
			const started = Date.now();
			const path = (args.path ?? args.name ?? args.from ?? args.folder ?? null) as string | null;
			try {
				const result = await fn(args);
				log("info", "tool", { client: client.id, tool, path, ms: Date.now() - started, outcome: "ok" });
				return ok(result);
			} catch (error) {
				const code = error instanceof MemoryError ? error.code : "INTERNAL";
				log(code === "INTERNAL" ? "error" : "info", "tool", { client: client.id, tool, path, ms: Date.now() - started, outcome: "error", code, ...(code === "INTERNAL" ? { error: String((error as Error)?.stack ?? error) } : {}) });
				return fail(error);
			}
		};

	const read = { readOnlyHint: true, openWorldHint: false } as const;

	server.registerTool(
		"list",
		{
			title: "List notes",
			description: "Without folder: the short index (notes of the main folders in full, one line per other folder). With folder: every note in it with its description, aliases and last change.",
			inputSchema: {
				folder: z.string().optional().describe("Top-level folder, e.g. «personas»."),
				include_archive: z.boolean().optional().describe("Include the archive folder (default false)."),
				limit: z.number().int().min(1).max(1000).optional(),
				cursor: z.string().optional().describe("next_cursor from the previous page."),
			},
			annotations: read,
		},
		wrap("list", (a: { folder?: string; include_archive?: boolean; limit?: number; cursor?: string }) => memory.list(a)),
	);

	server.registerTool(
		"search",
		{
			title: "Search notes",
			description:
				"Full-text search (accents ignored, word prefixes match). Returns the best sections with a snippet; read the note or the section next. Use quotes for exact phrases. The archive is excluded unless include_archive.",
			inputSchema: {
				query: z.string().describe("Words to look for."),
				folder: z.string().optional(),
				include_archive: z.boolean().optional(),
				limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
			},
			annotations: read,
		},
		wrap("search", (a: { query: string; folder?: string; include_archive?: boolean; limit?: number }) => memory.search(a)),
	);

	server.registerTool(
		"read",
		{
			title: "Read a note",
			description: "Whole note (frontmatter included) or one section, plus its `hash` (needed to write, move or delete it), its sections and link counts. `revision` reads an older version from git.",
			inputSchema: {
				path: notePath,
				name: noteName,
				section: z.string().optional().describe("Heading text of the section to return."),
				revision: z.string().optional().describe("Commit to read from, e.g. a hash from `history`."),
			},
			annotations: read,
		},
		wrap("read", (a: { path?: string; name?: string; section?: string; revision?: string }) => memory.read(a)),
	);

	server.registerTool(
		"links",
		{
			title: "Links of a note",
			description:
				"Outgoing [[links]] (with broken ones as target_path null) and incoming backlinks with the line that contains them. Typed links (`key:: [[x]]`) carry their `relation`; pass `relation` to get only those, e.g. who `works_at` this note.",
			inputSchema: {
				path: notePath,
				name: noteName,
				direction: z.enum(["in", "out", "both"]).optional(),
				relation: z.string().optional().describe("Only links of this relation key, e.g. works_at."),
			},
			annotations: read,
		},
		wrap("links", (a: { path?: string; name?: string; direction?: "in" | "out" | "both"; relation?: string }) => memory.links(a)),
	);

	server.registerTool(
		"history",
		{
			title: "History of a note",
			description: "Commits that changed the note, newest first: who, when, why (message) and trailers (Client, Tool, Session).",
			inputSchema: { path: notePath, name: noteName, limit: z.number().int().min(1).max(200).optional() },
			annotations: read,
		},
		wrap("history", (a: { path?: string; name?: string; limit?: number }) => memory.history(a)),
	);

	server.registerTool(
		"recent",
		{
			title: "Recent changes",
			description:
				"Commits across the whole memory, newest first: who, when, why and which files each one added, modified, deleted or renamed. Use it to catch up on what changed since a date (`since`) or since a commit you saw (`after`), or to find the commit to `revert`.",
			inputSchema: {
				since: z.string().optional().describe("Only commits from this date on, e.g. «2026-10-01»."),
				after: z.string().optional().describe("Only commits after this one (a hash from an earlier `recent` or `history`)."),
				folder: z.string().optional().describe("Only commits that touched this top-level folder."),
				limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
				cursor: z.string().optional().describe("next_cursor from the previous page."),
			},
			annotations: read,
		},
		wrap("recent", (a: { since?: string; after?: string; folder?: string; limit?: number; cursor?: string }) => memory.recent(a)),
	);

	if (client.scope !== "write") return server;

	server.registerTool(
		"create",
		{
			title: "Create a note",
			description:
				"Creates a new note from full Markdown including frontmatter (required fields: see the rules). The file name must be unique across all folders. If existing notes look like the same thing, it fails with DUPLICATE_CANDIDATES: read them, and only if this is really new, retry with confirm_new: true.",
			inputSchema: {
				path: z.string().describe("Where to create it, e.g. «people/sam.md»."),
				content: z.string().describe("Full note: frontmatter between --- lines, then the body."),
				reason,
				confirm_new: z.boolean().optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		wrap("create", (a: { path: string; content: string; reason: string; confirm_new?: boolean }) => memory.create(client, a)),
	);

	server.registerTool(
		"edit",
		{
			title: "Edit a note",
			description:
				"Exact text replacements, applied in order and all-or-nothing. Each old_string must appear exactly once (or set replace_all). Best for adding or changing a sentence; to rewrite a whole note use `write`.",
			inputSchema: {
				path: notePath,
				name: noteName,
				edits: z
					.array(z.object({ old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }))
					.min(1),
				reason,
				hash: hash.optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		wrap("edit", (a: { path?: string; name?: string; edits: { old_string: string; new_string: string; replace_all?: boolean }[]; reason: string; hash?: string }) => memory.edit(client, a)),
	);

	server.registerTool(
		"write",
		{
			title: "Rewrite a note",
			description: "Replaces a whole existing note. Requires the hash from `read`; if the note changed since, it fails with CONFLICT and returns the current content.",
			inputSchema: { path: notePath, name: noteName, content: z.string(), hash, reason },
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
		},
		wrap("write", (a: { path?: string; name?: string; content: string; hash: string; reason: string }) => memory.write(client, a)),
	);

	server.registerTool(
		"move",
		{
			title: "Move or rename a note",
			description: "Moves a note to another path. If its name changes, every [[link]] to it is rewritten in the same commit. Moving to the archive folder retires a note.",
			inputSchema: {
				from: z.string().describe("Current path or name."),
				to: z.string().describe("New path, e.g. «archivo/piso-viejo.md»."),
				hash,
				reason,
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		wrap("move", (a: { from: string; to: string; hash: string; reason: string }) => memory.move(client, a)),
	);

	server.registerTool(
		"delete",
		{
			title: "Delete a note",
			description: "Removes a note (it stays in git history). Fails with HAS_BACKLINKS while other notes link to it. Prefer moving outdated notes to the archive.",
			inputSchema: { path: notePath, name: noteName, hash, reason },
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
		},
		wrap("delete", (a: { path?: string; name?: string; hash: string; reason: string }) => memory.delete(client, a)),
	);

	server.registerTool(
		"revert",
		{
			title: "Undo a commit",
			description:
				"Undoes one earlier change with a new commit (history keeps both), like `git revert`. Find the commit with `recent` or `history`. Fails with REVERT_CONFLICT when later commits changed the same lines (it lists them: revert those first, newest first), with HAS_BACKLINKS if it would remove a note others still link to, and with NAME_TAKEN if a note it would bring back clashes with a newer one.",
			inputSchema: {
				commit: z.string().describe("Hash of the commit to undo (full or abbreviated)."),
				reason,
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		wrap("revert", (a: { commit: string; reason: string }) => memory.revert(client, a)),
	);

	server.registerTool(
		"attach",
		{
			title: "Attach a file",
			description:
				"Stores a binary (PDF, image…) with git LFS and creates a companion note next to it with its text (PDFs) so it can be searched. Send the bytes as base64 for small files, or upload first with PUT /uploads/<filename> and pass upload_id.",
			inputSchema: {
				path: z.string().describe("Where the file goes, e.g. «temas/escritura-casa.pdf»."),
				upload_id: z.string().optional(),
				base64: z.string().optional(),
				name: z.string().optional().describe("Companion note name; defaults to the file name without extension."),
				title: z.string().optional().describe("Human title of the companion note."),
				description: z.string().describe("One line describing the file."),
				aliases: z.array(z.string()).optional(),
				reason,
				confirm_new: z.boolean().optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		wrap(
			"attach",
			(a: { path: string; upload_id?: string; base64?: string; name?: string; title?: string; description: string; aliases?: string[]; reason: string; confirm_new?: boolean }) =>
				memory.attach(client, { ...a, source: { upload_id: a.upload_id, base64: a.base64 } }),
		),
	);

	return server;
}
