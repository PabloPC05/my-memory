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
```

- **Stack:** TypeScript on Node.js 24; the official `@modelcontextprotocol/sdk` for the Streamable HTTP transport and the OAuth helpers; express; the built-in `node:sqlite` (FTS5, WAL); the `git`, `git-lfs` and `pdftotext` binaries called with `execFile`, never through a shell.
- **Two listeners.** The listener a request arrives on decides which credentials it accepts, without trusting proxy headers. The public one, meant to sit behind a reverse proxy, accepts only OAuth access tokens, so a leaked static token is useless from the internet; it has no uploads or webhook. Both listeners are optional: a setup with only local clients runs the private one alone.

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

**Ranking.** `bm25` with weights 5, 4, 3, 2, 1 for title, aliases, description, heading and body. The query is built from the user's words: each word of three or more letters becomes a prefix term, quoted text stays a phrase, and terms are ANDed, falling back to OR when that finds nothing. Raw FTS5 syntax is not exposed, so there are no query syntax errors. There are no embeddings: the design goal was to keep everything on a small server without a GPU, and the client's model can retry with synonyms for free.

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

Binaries go to git LFS: `attach` adds the LFS rule for the extension to `.gitattributes` the first time it is needed. Next to each binary goes a companion note with its title, description, an embed and, for PDFs, the text from `pdftotext`, one section per page. A PDF that yields almost no text is treated as a scan: the note says so and the call returns `EXTRACTION_EMPTY`. Large files are uploaded first with a streaming `PUT /uploads/:filename` on the private listener (no size limit beyond free disk space) and attached by `upload_id`.

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

## Agent setup guide

[docs/agent-setup.md](agent-setup.md) ships inside the package and the server offers it offline to every connected client: as the MCP prompt `setup` ("Set up this memory on your host") and as the resource `memory://agent-setup`, both with the Markdown of the guide. The server instructions mention them, so an agent on an unconfigured host can follow the guide without being given the URL. Agents compare the `memory-setup <version>` line they installed with the guide's version (see the [changelog](agent-setup/changelog.md)), and the `clients` view shows which version each one has.

The guide's Claude Code hooks live next to it in `docs/agent-setup/claude-code/`: dependency-free Node scripts that the agent copies to `~/.claude/hooks/`, each with a self-running test that the vitest suite executes. Two enforce the memory (`block-native-memory.mjs` refuses writes to Claude Code's own memory; `remind-memory.mjs` reminds the agent what "my memory" means when a message talks about saving). The optional third, `inject-memory.mjs`, brings recall to the agent instead of waiting for it to search: on `UserPromptSubmit` it turns the message into a keyword query (stopwords dropped, slash commands and short messages skipped), calls `search` over MCP with its own read-only token and adds the top hits (note, section, snippet) as `additionalContext`, framed as information to read before relying on, within a character budget; on `SessionStart` it can add the short index for hosts that truncate server instructions. It speaks plain JSON-RPC over Streamable HTTP: a bare `tools/call` first, which this stateless server answers in one round trip, and the `initialize` handshake with session id only if that is refused (gateways), reading JSON or SSE answers. It talks to nothing but the configured URL, and on any error, timeout (2.5 s by default) or missing setting it prints nothing and exits 0, so it can never hold up a message.

## Observability

One JSON line per request on stdout (journald under systemd): client, tool, path, duration, outcome, commit and warnings. Note content, search queries (only their length) and tokens are never logged. Sync events, reindex runs and auth failures are logged too; `error` is reserved for things worth alerting on: a remote conflict that dropped a change, pushes failing for more than ten minutes, an invalid `memory.toml`.
