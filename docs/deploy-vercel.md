# Deploy on Vercel (GitHub + Google Drive, no server)

my-memory can run without a server of your own:

- **the notes** live in a private GitHub repository of yours, read and written through GitHub's API (every write is still one commit, attributed to the client that made it);
- **your files** stay in your Google Drive: agents search them by name instantly (an index kept in memory, like FSearch or Everything) or by content (Drive's own full-text index), and read them;
- **a sources folder** in your Drive (for example `Memoria/Fuentes`) feeds the memory: whatever you drop there is read by an agent of your choice, which updates the notes and cites the document as `source:<Drive file id>`;
- **the server** is one Vercel function: it starts on demand, rebuilds its search index in `/tmp` on a cold start and catches up with GitHub before each request.

Running it on your own machine (git, LFS, OCR, OAuth with Forgejo) is described in the [README](../README.md#running-it); both modes serve the same tools.

## What you need

1. A **GitHub repository** for the notes (private), with a `memory.toml` and an `AGENTS.md` (copy them from an existing memory or start from the README's examples), and a **fine-grained token** with *Contents: read and write* on that repository only.
2. Optional, for files and sources: a **Google Cloud project** with the Drive API enabled and an OAuth client (type *Desktop app* or *Web application*). Put the consent screen **In production** (a personal, unverified app is fine; Google shows a warning once): in *Testing*, refresh tokens expire after 7 days.
3. Optional, for the ingestion agent: an API key for the model (an Anthropic key for Claude, or any OpenAI-compatible endpoint), or a webhook of your own.
4. A **Vercel** account. Hobby works; its crons run once a day, which is enough because Drive's push notices are what make ingestion immediate.

## 1. The Google refresh token

The server reads your Drive as you, with a refresh token. One way to get it, without writing code:

1. In the OAuth client, add `https://developers.google.com/oauthplayground` as an authorized redirect URI (Web application type).
2. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), click the gear, tick *Use your own OAuth credentials* and paste the client id and secret.
3. Authorize these scopes: `https://www.googleapis.com/auth/drive.readonly` and `https://www.googleapis.com/auth/drive.appdata`, then *Exchange authorization code for tokens* and copy the **refresh token**.

`drive.readonly` is enough to index, search and read; my-memory never changes your files. `drive.appdata` lets it keep a snapshot of the index in the app's hidden folder of your Drive, so a cold start reads one small file instead of listing your whole Drive; without it everything still works, only cold starts are slower.

## 2. Deploy

Import the my-memory repository (or your fork) in Vercel; `vercel.json` already sets the build, the function (300 s, 1 GB) and the daily cron. Then add the environment variables:

| Variable | |
|---|---|
| `GITHUB_REPO` | `owner/repo` of the notes |
| `GITHUB_TOKEN` | The fine-grained token |
| `GITHUB_BRANCH` | Default `main` |
| `MEMORY_TOKENS` | One line (or comma) per client: `id:scope:token:Name`, scope `read` or `write`, the token at least 20 random characters (or `sha256:<hex>` of it). Example: `claude:write:7f3…e1:Claude,laptop:write:a9c…02:Claude Code (laptop)` |
| `CRON_SECRET` | Any long random string: Vercel sends it to the cron route, and the server uses it to chain ingestion runs |
| `PUBLIC_URL` | Optional; default `https://<production domain>` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Your Drive (omit all three for a memory without files) |
| `DRIVE_SOURCES_FOLDER` | The sources folder, by path in My Drive (`Memoria/Fuentes`) or by id |
| `DRIVE_PUSH_TOKEN` | Any long random string: turns on Drive's push notices to `<PUBLIC_URL>/hooks/drive` |
| `INGEST_PROVIDER` | `anthropic`, `openai` or `webhook` (omit for no ingestion) |
| `ANTHROPIC_API_KEY` or `INGEST_API_KEY` | The model's key |
| `INGEST_MODEL` | Default `claude-opus-5-5` for `anthropic`; required for `openai` |
| `INGEST_BASE_URL` | Required for `openai` (`https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, …) |
| `INGEST_WEBHOOK_URL`, `INGEST_WEBHOOK_SECRET` | For `webhook` |
| `INGEST_MAX_FILES`, `INGEST_MAX_STEPS` | Per run (default 10) and tool calls per source (default 30) |
| `FUNCTION_MAX_DURATION` | Match `maxDuration` in `vercel.json` if you change it (Pro allows up to 800) |
| `EMBEDDINGS_URL`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_API_KEY` | Optional search by meaning, as `[embeddings]` in the README |

Deploy, then open `https://<your domain>/cron/ingest` once with the header `Authorization: Bearer <CRON_SECRET>` (or wait for the daily cron): it indexes your Drive, ingests what is already in the sources folder and opens the push channel.

## 3. Connect your agents

- **Claude Code, Codex, your own agents:** `https://<your domain>/mcp` with `Authorization: Bearer <token>`.
- **claude.ai** (custom connector, which takes a URL and no header): `https://<your domain>/t/<token>/mcp`. Whoever has that URL has that token's access, so give claude.ai a token of its own; to revoke it, remove its line from `MEMORY_TOKENS` and redeploy.

Then give the agent the setup link from the README, as with a self-hosted memory.

## How it behaves

- **Notes.** A cold start downloads the repository as one tarball and builds the index in `/tmp` (seconds for a few thousand notes). Each request first asks GitHub whether the branch moved (one small API call, at most every 5 s) and applies the difference, so several copies of the function running at once see each other's writes. A write is a commit made through GitHub's API and published by moving the branch without force; if another copy changed other notes meanwhile, it is rebased on top; if it changed the same note, the write fails with `REMOTE_CONFLICT` and the agent reads the note again. Your backup is the GitHub repository (any `git clone` of it).
- **Files.** `files_search` answers by name from memory in milliseconds; `content: true` asks Drive's full-text index. `files_read` gives the text of text files, Google Docs, Sheets (CSV), Slides and Word documents; other files (PDF, images…) come back whole for the agent to read. Files only shared with you, outside My Drive, are left out.
- **Sources.** Each document's identity is its Drive file id, which survives renames, moves and new versions. What the memory integrated, and at which version, is kept in `.my-memory/sources.json` in the notes repository (hidden from the tools). A run compares the folder with that file, so a lost notice only delays a document until the next run. A new version of a document is integrated again (the agent updates the notes that cite it); a removed one is marked in those notes as no longer available. A document that fails is retried up to 3 times, then waits for a new version. A run takes a lease in the same file, so two notices for the same upload never ingest it twice.
- **Triggers.** Drive calls `/hooks/drive` within seconds of a change; the answer is immediate and the work continues in the background (`waitUntil`). The daily cron is the safety net and renews the push channel, which Drive keeps for a week at most. When a run has no time left (it stops starting documents 2 minutes before the function's limit), it starts a new invocation for the rest.

## Limits

- **Time:** 300 s per invocation on Hobby (up to 800 s on Pro). Long documents with many notes to update may take a minute each with the default model.
- **`/tmp`:** 500 MB per instance; the notes, the index and uploads go there. Fine for text notes; a memory full of large attachments is better self-hosted.
- **No OCR or `pdftotext`** in the function: `attach` stores files, but scanned PDFs are not turned into text. Documents in the sources folder do not need it: the ingestion agent reads PDFs and images itself (Claude), and Drive's full-text index already covers them for `files_search`.
- **Uploads** (`PUT /uploads/…` then `attach`) only work when both requests reach the same instance; prefer the sources folder for documents.
- **No OAuth sign-in** (the self-hosted public listener delegates it to Forgejo): clients use static tokens.

## Why not Vercel's `mcp-handler`

[`mcp-handler`](https://github.com/vercel/mcp-handler) is Vercel's adapter for MCP servers written for its runtime. my-memory already speaks MCP over stateless Streamable HTTP (no sessions, no SSE, so no Redis), through the official SDK and Express, which Vercel runs as is; the same code serves the self-hosted listeners, and `src/vercel.ts` only swaps the git clone for GitHub's API and the TOML config for environment variables.
