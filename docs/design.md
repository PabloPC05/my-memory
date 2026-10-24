# Design

How my-memory works inside, for people who want to run it, change it or build something similar. The [README](../README.md) covers tools, configuration and deployment.

## Architecture

```text
 remote clients (claude.ai…)                  local / private-network clients
          │ HTTPS (reverse proxy)                 (Claude Code, Codex, your bots)
          ▼                                                │
 public listener: OAuth access tokens only                 ▼
          │                         private listener: static tokens or OAuth,
          │                         PUT /uploads, POST /hooks/forgejo
          └───────────────┬──────────────────────────────┘
                          ▼
           my-memory (one Node.js process)
           ├─ MCP server (Streamable HTTP, stateless)
           ├─ OAuth 2.1 authorization server (DCR, PKCE) ──► Forgejo OAuth2 for the user login
           ├─ write queue (one global mutex)
           ├─ repo/          working clone of the notes repo
           ├─ index.sqlite   derived index, rebuildable from git
           ├─ state.sqlite   OAuth clients, codes and tokens (not derivable)
           ├─ activity.sqlite  last seen per client (not derivable, not in the notes repo)
           └─ uploads/       pending uploads
                          │ fetch / push
                          ▼
           git remote (Forgejo, or any git server) + LFS store

           optional: an embeddings endpoint (Ollama, llama.cpp, TEI, OpenAI…) for search by meaning
```

- **Stack:** TypeScript on Node.js 24; the official `@modelcontextprotocol/sdk` for the Streamable HTTP transport and the OAuth helpers; express; the built-in `node:sqlite` (FTS5, WAL); the `git`, `git-lfs`, `pdftotext`, `pdftoppm` and `tesseract` binaries called with `execFile`, never through a shell.
- **Two listeners.** The listener a request arrives on decides which credentials it accepts, without trusting proxy headers. The public one, meant to sit behind a reverse proxy, accepts only OAuth access tokens, so a leaked static token is useless from the internet; it has no uploads or webhook. Both listeners are optional: a setup with only local clients runs the private one alone.

## Where the notes live

The memory talks to its notes through a small interface (`NoteStore` in `src/store.ts`): the files of HEAD in a local folder, commit, fetch, history, revert. Two implementations:

- **`GitStore`**, the self-hosted default: a working clone driven by the `git` binary, pushed to any git remote, with LFS for attachments. A write commits locally and pushes; pushes from elsewhere are integrated by rebase.
- **`GitHubStore`**, for hosts without a disk or a git binary (Vercel): the files of HEAD come from one tarball download into `/tmp`; a write builds blobs, a tree and a commit with GitHub's Git Data API and moves the branch **without force**. If the branch moved meanwhile, the remote commits are fetched: when they touched other files, the write is rebased on top and retried; when they touched the same file, the remote wins (`StoreConflictError`, which the tools report as `REMOTE_CONFLICT` with the note as it is now). History, `recent` and `revert` read GitHub's commits API; reverts merge with `node-diff3`. Every commit is published as it is made, so there is never anything local to lose.

The index is the same in both: SQLite, rebuilt from the files when it is missing.

## Files and sources

With `[drive]` (or the `GOOGLE_*` variables), the server also serves the user's Google Drive:

- **`DriveFiles`** lists My Drive once (id, name, parents, type, size, md5, date) and keeps it current with Drive's changes feed; paths are computed from the parents. Name search runs over that list in memory (every word in the name or the path, accents ignored; name matches first, then the most recent). Content search is Drive's own `fullText contains`, which covers PDFs, Office files and OCR'd images without downloading anything. A gzipped snapshot of the list, with the changes token, is kept in the app's hidden folder (`appDataFolder`), so a cold start reads one file and applies the changes since.
- **The sources folder** is a Drive folder (by path or id). Its documents are identified by their Drive file id, which survives renames, moves and new versions; notes cite them as `source:<id>` and `files_info` / `files_read` take that id. `.my-memory/sources.json` in the notes repo records, per document, the version (md5, or the modification time for Google's formats) the memory integrated and what happened; dot-folders are invisible to the tools and the index.
- **`Ingester`** compares the folder with that state and hands each new, changed or removed document to the configured agent, a few per run, saving the state after each one (a run cut short loses at most the document it was on). Failures are retried 3 times per version. On hosts that run several copies at once, a run first commits a lease into the same file; since the store refuses a second commit on top of a file someone else just changed, only one copy ingests.
- **The agents** get the memory's own instructions (`AGENTS.md` and the short index) as the system prompt, a brief saying what to do with this document and how to cite it, the document (text; PDFs and images as content blocks for Claude), and the memory tools (`search`, `list`, `read`, `links`, `create`, `edit`, `write`) run in-process as the client `ingest`, so every change is a normal attributed commit. `anthropic` uses the SDK's tool runner; `openai` is a function-calling loop over any compatible chat completions API; `webhook` hands the document's id and the brief to another program, which writes through MCP like any client.
- **Triggers** all run the same idempotent pass: Drive's push notices (`/hooks/drive`, a channel opened with `changes.watch` and renewed before its one-week expiry), a timer on a long-lived server, and `/cron/ingest` on a serverless one.

## Resuming a topic

`resume` is a read made for handing a topic from one agent to another cheaply. It resolves the topic (a name, a path, or the best search hit, with the runners-up), and returns the note's description, the sections named in `[resume] sections` whole (with their subsections), only the headings of the rest, and the latest commits to the note (date, author, reason), or only those after `since`. Its description asks agents to keep those sections current as they work; that, not a summary written at the end, is what lets the next agent continue.

## Serverless

`src/vercel.ts` builds the same Express app as the private listener, with `GitHubStore`, the configuration from environment variables, static tokens from `MEMORY_TOKENS` and the token also accepted in the path (`/t/<token>/mcp`) for clients that take only a URL. One instance serves many requests: it syncs with GitHub before a request when the last sync is more than 5 s old (one ref lookup; the files that changed are fetched one by one). Work after the answer (Drive's notices) goes to `waitUntil`. See [deploy-vercel.md](deploy-vercel.md).

## Notes

A notes repo is plain Markdown with YAML frontmatter:

```markdown
---
name: Kitchen renovation
description: Budget, quotes and schedule for the kitchen
aliases: [kitchen]
---
# Kitchen renovation

Quote from [[acme-builders]], see ![[quote.pdf]].
contractor:: [[acme-builders]]
```

- **Names.** A note's name is its file name without `.md`, unique across the repo (case-insensitive), so `[[name]]` always resolves and survives moves between folders. This matches Obsidian's "shortest path" links.
- **Required fields** (`name`, `description` by default) are checked on writes. Dates and authors are never stored in the file: they come from `git log`.
- **Superseded notes** go to the archive folder with `superseded_by: "[[new-note]]"`.
- **Typed links** are Dataview inline fields: `key:: [[x]]` on its own line or list item, `[key:: [[x]]]` or `(key:: [[x]])` inside a sentence, or a frontmatter field whose value holds links. Every link in the field's value gets the key as its relation. `name`, `description`, `aliases` and `attachment` never carry relations.
- **`memory.toml`** at the repo root declares the conventions (folders, archive, required fields, file name pattern, relation vocabulary, instructions file). An invalid file is never applied; the server keeps the last valid one.
- **Legacy frontmatter** that strict YAML rejects (typically an unquoted `: ` inside a value) is read leniently and reported as a problem. Writes must produce valid YAML, except that an edit may leave an already broken frontmatter block exactly as it was.

## Index

`index.sqlite` is derived and disposable; `my-memory reindex` rebuilds it from the working tree.

- **Catalog** (`notes`): path, name, folder, title, description, aliases, archived, superseded_by, attachment, the git blob hash (the `hash` of the tools), dates and authors from git, and `problems`.
- **Full text** (`sections` + `sections_fts`): one row per section. The text before the first `##` is a section named after the title; `##` and `###` start new ones; deeper headings stay inside. FTS5 with `unicode61 remove_diacritics 2`, so accents don't matter. Title, aliases and description are stored only with a note's first section, so matches on them point at the top of the note.
- **Links** (`links`): source, target name, resolved target (null when broken), heading, embed, relation and line. Links inside code are ignored.
- **Vectors** (`vectors`, only with `[embeddings]`): one `Float32Array` BLOB, normalized to unit length, per distinct section text. The text is the section with the note's title (`Title › Heading`), and for the first section also its aliases and description, the same context the full-text columns give it. Each section row stores the SHA-256 of that text (`embed_hash`) and vectors are keyed by it, so a section that did not change keeps its vector through edits of other sections, moves and full rebuilds. The model, `dimensions`, `document_prefix` and the cut length are recorded in `meta`; when they change, every vector is dropped and rebuilt. Vectors no section uses any more are pruned.

**Ranking.** Full text is `bm25` with weights 5, 4, 3, 2, 1 for title, aliases, description, heading and body. The query is built from the user's words: each word of three or more letters becomes a prefix term, quoted text stays a phrase, and terms are ANDed, falling back to OR when that finds nothing. Raw FTS5 syntax is not exposed, so there are no query syntax errors.

Search by meaning is optional, because the goal is still a small server without a GPU: the server holds no model and adds no dependency. It calls an OpenAI-compatible `/v1/embeddings` endpoint configured in `[embeddings]` with the built-in `fetch`. That can be Ollama or llama.cpp running a small model on the same CPU (`nomic-embed-text`, `bge-m3`, `multilingual-e5-small`), a TEI container, or a hosted API. Without `[embeddings]` search is exactly the full-text search above and nothing is embedded.

With it, `search` takes a `mode`: `hybrid` (the default), `text` or `semantic`. Hybrid embeds the query and scores every section that has a vector by cosine similarity, a dot product of unit vectors brute-forced in JS (a few thousand sections take milliseconds, so there is no ANN index). The best 30 (or three times `limit`) of each ranking, the bm25 one with its AND-then-OR fallback and the cosine one, are fused by Reciprocal Rank Fusion (`Σ 1/(60 + rank)`). Sections found by text keep their highlighted snippet; sections found only by meaning get the start of their text. The result has the same shape as a text search, with `mode` saying which ranking answered. If the query cannot be embedded (endpoint down, slow or erroring, 5 s at most), search answers with the full-text search and logs a warning without the query, then skips the endpoint for 30 s so an outage does not slow every search. Sections not embedded yet are simply found by text only.

**Embedding never blocks a write.** Each reindex, incremental or full, ends by asking the background embedder for a run, after the index transaction has committed. The embedder reads the sections whose `embed_hash` has no vector, sends them in batches of `batch_size` (texts cut at 4000 characters), and stores each batch in its own short transaction. node:sqlite is synchronous and every reindex transaction runs without awaiting, so these small writes never interleave with one, and WAL keeps reads going. When the endpoint fails, the embedder retries with backoff (30 s, doubling up to 10 min) and logs `embeddings.failed` with how many sections are pending. A text the endpoint refuses (a 4xx other than 429, typically too long for the model) is retried alone and set aside until restart, so it cannot block the others. At startup the server logs `embeddings.status` with the model, the vectors stored and the sections pending, and each run that embedded something logs `embeddings.done`. `my-memory reindex` rebuilds the index and then embeds whatever is missing in the foreground; `--reembed` drops all the vectors first.

**Incremental reindex.** After each commit or pull the server diffs the indexed commit against HEAD with `git diff --name-status`, reparses the changed files and re-resolves links, all in one transaction that also stores the new indexed commit. At startup: a schema change or an indexed commit that is not an ancestor of HEAD means a full rebuild; otherwise incremental. A change to `memory.toml` also triggers a full rebuild.

## Writes

Every write goes through one in-process queue. Reads take no lock: SQLite runs in WAL mode and files are replaced by writing a temp file and renaming it.

```text
 1. authenticate → client identity and scope
 2. take the write lock; if a remote change is pending, sync first
 3. validate: path, file name, hash, frontmatter, duplicates, backlinks
 4. apply to the working tree (for move, also rewrite the notes that link to it)
 5. git commit
      author:  "<client name> <client-id@my-memory.invalid>"
      subject: the reason the agent gave
      trailers: Client, Tool, Session
 6. incremental reindex
 7. push; if rejected: fetch + rebase
      clean    → push again
      conflict → abort, reset to the remote, full reindex → REMOTE_CONFLICT (the remote wins)
    if the remote is down: keep the commit, answer PUSH_PENDING, retry with backoff
 8. release the lock, log one JSON line, return
```

- **Optimistic concurrency.** `read` returns the note's git blob hash. `write`, `move` and `delete` require it and fail with `CONFLICT` and the current content when it no longer matches; `edit` takes it optionally and otherwise relies on its `old_string` still being there.
- **Duplicates.** `create` compares the new note's labels (name, title, aliases, normalized) with the existing ones and refuses with `DUPLICATE_CANDIDATES` unless the agent confirms. Labels count as the same when they are equal, within a small edit distance (25 % for single words, 12 % for several), or when all the words of a label of six or more characters appear in the other.
- **Backlinks.** `move` rewrites every `[[link]]` to the note in the same commit, keeping headings, aliases and relation keys. `delete` refuses while other notes link to the note.
- **Revert.** `revert` takes a commit on the current branch (not a merge) and, optionally, one note of it, and writes the files it touched back to their state in its parent, as one normal write: same queue, one commit by the client with a `Reverts: <hash>` trailer, incremental reindex, same push and conflict rules. A file changed again later is three-way merged (`git merge-file`: current, the commit's version, the parent's version), so later changes that don't overlap survive; if they overlap, or the file was deleted, moved or created again since, nothing is written and it fails with `REVERT_CONFLICT` and the later commits that touched it. Undoing a create deletes the note and follows the `delete` rule: `HAS_BACKLINKS` while notes outside the revert link to it. Undoing a delete restores the note, if its path is free and its name still unique (`NAME_TAKEN`). Undoing a move moves it back, and the link rewrites of that move are other files of the same commit, so they are undone too. Binaries are never rewritten from history (the worktree holds LFS pointers and the objects may not be local): undoing an `attach` removes the binary, moving it back is a plain rename, and restoring or changing one fails with `NOT_RESTORABLE` (the companion note alone can be restored with `path`). `.gitattributes` is never reverted, so LFS rules stay, and every path the revert would touch goes through the same path checks as the other writes (no hidden files such as `.gitignore`, allowed folders, root files), or it fails with `INVALID_PATH`. A file brought back unchanged (nothing else touched it since) is copied byte for byte from the blob. Any failure resets the worktree to HEAD, as for every write.
- **Recent changes.** `recent` reads `git log` of the branch (with rename detection): per commit the date, author, `Client`/`Tool`/`Session`/`Reverts` trailers, the subject (the reason) and the files with their change type. `since` (ISO date or `30m`/`12h`/`7d`/`2w`) and `folder` go to git; `client` (trailer or author name) and the archive filter (files only in the archive are hidden unless `include_archive`, and so are commits that touched nothing else) are applied to pages of the log.
- **Outside changes** (a push from a laptop, an edit in Forgejo's web UI) arrive through a webhook with an HMAC signature, with a periodic fetch as a safety net. The server fast-forwards, or rebases its unpushed commits on top with the same conflict rule, and reindexes. Outside pushes are not validated; problems found while indexing are reported by `list` and `read`.
- **Crash safety.** At startup a dirty working tree means a crash mid-write: it is reset to HEAD and the discarded paths are logged. Then the index is reconciled and pending commits are pushed.

| Case | Behavior |
|---|---|
| Two agents write different notes | Serialized; two commits |
| Two agents `edit` the same note | Serialized; the second fails with `EDIT_NO_MATCH` if its text is gone |
| Two agents `write` the same note from the same read | The first wins; the second gets `CONFLICT` |
| A human pushes while an agent writes | Rebase; on conflict the remote wins and the agent gets `REMOTE_CONFLICT` |
| The git remote is down | Commits pile up locally; `PUSH_PENDING` until it is back |

## Attachments

Binaries go to git LFS: `attach` adds the LFS rule for the extension to `.gitattributes` the first time it is needed. Next to each binary goes a companion note with its title, description, an embed and, for PDFs, the text from `pdftotext`, one section per page (`page_heading`). The frontmatter's `extracted_with` says where the text came from (`pdftotext`, `ocr` or `none`).

- **OCR, optional and local.** A PDF that yields almost no text (under 20 characters per page) is treated as a scan. If OCR is available, it is OCR'd page by page: `pdftoppm` renders each page to a PNG at 300 dpi in its own temp dir, `tesseract` reads it with the configured languages (`[ocr] languages`, e.g. `spa+eng`), and the temp dir is removed right after, whatever happens. Pages keep their numbers and their sections; the note starts with a line saying the text comes from OCR (`ocr_notice` in `memory.toml`). Only the first `max_pages` pages are OCR'd and a page that fails or times out (`page_timeout_seconds`) is skipped; either way the call returns `EXTRACTION_PARTIAL`. Images (`png`, `jpg`, `jpeg`, `webp`, `tif`, `tiff`) are OCR'd with `tesseract` too, their text right under the embed (sections only for multi-page TIFFs).
- **Fallback.** When OCR is disabled, the tools are missing or OCR finds nothing either, the note keeps just the embed and the call returns `EXTRACTION_EMPTY` with the reason (e.g. "OCR unavailable: tesseract is not installed"); other file types get `EXTRACTION_EMPTY` as before. The tools and the installed languages are probed once at startup and logged (`ocr.tools`); requested languages that are not installed are dropped, and a missing tool never stops the server.
- **Extraction runs before the write lock**, on the uploaded file only, so a slow OCR never blocks other writes.

Large files are uploaded first with a streaming `PUT /uploads/:filename` on the private listener (no size limit beyond free disk space) and attached by `upload_id`.

## Authentication

- **Static tokens** for local clients: one per client, `mm_` plus 32 random bytes, stored as SHA-256 hashes in a TOML file that the server reloads on `SIGHUP`. Each has an id (commit trailer and author email), a name (commit author) and a scope (`read` or `write`). Read-only clients don't see the write tools.
- **OAuth 2.1** for remote clients such as claude.ai. my-memory is its own authorization server, with discovery (RFC 9728 and RFC 8414), open dynamic client registration (registering grants nothing by itself) and mandatory PKCE. The user signs in through Forgejo's OAuth2, and only the logins in `allowed_users` get through. Access tokens live one hour; refresh tokens live 30 days and rotate on every use, and reusing a rotated one revokes its whole family. Everything is stored hashed. Commits from OAuth clients are authored `"<Forgejo full name> (<client name>)"`.
- **One credential per agent.** Identity is whatever credential the request carried, and that is all my-memory knows: the commit author, the `Client:` trailer, the log line and the `clients` view all use it. Two agents sharing a credential are one client to the server. Create one static token per agent (`my-memory token add <id> --name "<Agent name>" …`); OAuth clients get their own identity on registration. Behind a gateway or proxy that joins several MCP servers into one endpoint, the gateway is the client the server sees: give the gateway one key per agent and map each key to its own my-memory token, with the same public URL and a different key per agent, or every write is attributed to the gateway (done with Caddy plus agentgateway, but the pattern is generic). To verify, `my-memory clients` or the `clients` tool must show each agent on its own row.
- **The public listener** rate-limits the OAuth endpoints per IP and exposes nothing else without an access token.

## Connected clients

The `clients` tool (available to read-only tokens too) and `my-memory clients --config config.toml` (`--json` for scripts) answer "who is connected". The report joins three sources and never includes tokens or hashes:

- **Known clients:** every static token (from the tokens file, without hashes) and every OAuth client registered in `state.sqlite`.
- **Last seen:** `activity.sqlite` in the data dir, a small SQLite file of its own (not in the notes repo and not in the rebuildable index). It keeps per client the name, scope, last request time and last tool. The in-memory copy is always current; the file is written at most once a minute per client and on shutdown. The CLI reads a snapshot without side effects.
- **Writes:** counted from the `Client:` trailers of the commits on the current branch, for the last 7 and 30 days. A client that only appears in the activity log or in git (token revoked, OAuth app gone) is still listed and flagged as no longer known.
- **Setup version:** the latest `memory-setup <version>` record found in the notes, attributed to the client whose id or name appears nearby, or failing that to the only client named in the file or the author of the last commit that touched it. Best effort.

## Lint

Andrej Karpathy's "LLM wiki" pattern has the model do three things with a wiki: ingest sources, answer from it, and periodically lint it for contradictions, stale claims, orphan pages, concepts without a page of their own and missing cross-references. Most of that needs judgment, but finding the candidates does not. The `lint` tool (read-only tokens too) and `my-memory lint --config config.toml` (`--json`, `--kind`, `--folder`, `--limit`) are that cheap half: a worklist computed from the index and git dates, with no model, so the maintaining agent reads only the notes that need it and does the judgment half (is this a contradiction, does that inference still hold, merge or link, split where).

| Kind | Found from |
|---|---|
| `problems` | The catalog's `problems` (bad frontmatter, file names, relations), superseded notes outside the archive, duplicate names |
| `broken_link` | Links with no target |
| `duplicate_candidates` | Pairs of notes whose labels look alike, with the same rule as `create`'s `DUPLICATE_CANDIDATES`. Candidates come from a bigram index and a word index, exact filters for that rule (the q-gram bound for the edit distance, the rarest word for containment), so it is not quadratic and finds the same pairs |
| `old_inference` | Lines with an inference marker (`(deducido)`, `(deducido, 2026-01-31)`; the words come from `[lint] inferred_markers`) older than `inference_days`. An undated marker is at least as old as the note's last change |
| `missing_page` | A missing target linked from `missing_page_min` notes or more, reported once instead of as broken links |
| `unlinked_mention` | A note's name, title or alias in the plain text of a note that never links to it (whole words, accents ignored; ambiguous and short labels skipped; code, links and headings ignored) |
| `orphan` | Notes with no links in, except from the archive; root files count as sources. `orphan_exclude` folders (default `index_full`) are exempt |
| `stale` | Last commit older than `stale_days` |
| `oversized` | Files bigger than `max_bytes`, except attachment companions |

Root files and the archive are never reported, and `[lint] exclude` adds folders. Items come in the order of the table, worst first within each kind, each with its notes and a short detail (line, snippet, target, days); `counts` has the totals per kind before `limit`. Section text comes from the FTS table, which keeps it, so lint reads no files and needs no new index tables; a few thousand notes take well under a second. The CLI opens the index read-only and refuses one of another schema version instead of rebuilding it under a running server.

## Agent setup guide

[docs/agent-setup.md](agent-setup.md) ships inside the package and the server offers it offline to every connected client: as the MCP prompt `setup` ("Set up this memory on your host") and as the resource `memory://agent-setup`, both with the Markdown of the guide. The server instructions mention them, so an agent on an unconfigured host can follow the guide without being given the URL. Agents compare the `memory-setup <version>` line they installed with the guide's version (see the [changelog](agent-setup/changelog.md)), and the `clients` view shows which version each one has.

The guide's Claude Code hooks live next to it in `docs/agent-setup/claude-code/`: dependency-free Node scripts that the agent copies to `~/.claude/hooks/`, each with a self-running test that the vitest suite executes. Two enforce the memory (`block-native-memory.mjs` refuses writes to Claude Code's own memory; `remind-memory.mjs` reminds the agent what "my memory" means when a message talks about saving). The optional third, `inject-memory.mjs`, brings recall to the agent instead of waiting for it to search: on `UserPromptSubmit` it turns the message into a keyword query (stopwords dropped, slash commands and short messages skipped), calls `search` over MCP with its own read-only token and adds the top hits (note, section, snippet) as `additionalContext`, framed as information to read before relying on, within a character budget; on `SessionStart` it can add the short index for hosts that truncate server instructions. It speaks plain JSON-RPC over Streamable HTTP: a bare `tools/call` first, which this stateless server answers in one round trip, and the `initialize` handshake with session id only if that is refused (gateways), reading JSON or SSE answers. It talks to nothing but the configured URL (`https`, or plain `http` only to localhost), never follows redirects, and on any error, timeout (2.5 s by default) or missing setting it prints nothing and exits 0, so it can never hold up a message.

## Observability

One JSON line per request on stdout (journald under systemd): client, tool, path, duration, outcome, commit and warnings. Note content, search queries (only their length) and tokens are never logged, and neither are the texts sent to the embeddings endpoint or its API key. Sync events, reindex runs and auth failures are logged too; `error` is reserved for things worth alerting on: a remote conflict that dropped a change, pushes failing for more than ten minutes, an invalid `memory.toml`.
