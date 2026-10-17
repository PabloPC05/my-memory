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
- **Revert.** `revert` runs `git revert --no-commit` on one commit and goes through the same write path, so the undo is a new commit (with a `Reverts:` trailer) and nothing leaves the history. It refuses the first commit and merges. When later commits changed the same lines it aborts and answers `REVERT_CONFLICT` with those commits, so the agent can revert newest first instead of the server guessing. The invariants of the other tools still hold: a note it would bring back may not take a name another note has since (`NAME_TAKEN`), and a note it would remove may not still be linked from notes that stay (`HAS_BACKLINKS`). Frontmatter that no longer passes the rules comes back as a warning, since the point is to restore what was there.
- **Recent changes.** `recent` lists commits across the repo with the files each one added, modified, deleted or renamed. Commits are selected with `git rev-list --timestamp` and filtered by committer date in the server (git's own `--since` stops at the first older commit and misreads far-off dates), then described with one `git log --no-walk`.
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
- **The public listener** rate-limits the OAuth endpoints per IP and exposes nothing else without an access token.

## Observability

One JSON line per request on stdout (journald under systemd): client, tool, path, duration, outcome, commit and warnings. Note content, search queries (only their length) and tokens are never logged. Sync events, reindex runs and auth failures are logged too; `error` is reserved for things worth alerting on: a remote conflict that dropped a change, pushes failing for more than ten minutes, an invalid `memory.toml`.
