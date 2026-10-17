# my-memory

A self-hosted memory for AI agents. Your notes are a folder of Markdown files in git; my-memory serves them over [MCP](https://modelcontextprotocol.io) so any agent (Claude Code, Codex, claude.ai, your own bots) can search, read and write them. Every write is a git commit attributed to the client that made it.

*[Leer en español](README.es.md)*

> Keep this file and [README.es.md](README.es.md) in sync: when you edit one, update the other.

- **Git is the source of truth.** Search runs on a SQLite index (catalog, FTS5 full text by section, wikilinks) that can be rebuilt from git at any time.
- **One commit per write**, authored by the client: `Claude Code (laptop)`, `Alex (Claude)`…. The commit message is the reason the agent gave, plus `Client:` / `Tool:` / `Session:` trailers.
- **Safe for several agents at once.** One writer queue, optimistic concurrency (`hash` from `read`), and pushes from elsewhere (your PC, Forgejo's web editor) integrated by rebase.
- **Your conventions, not ours.** The notes repo declares its folders, required frontmatter and filename rules in `memory.toml`; its `AGENTS.md` is sent to every client as MCP instructions, with a short index.
- **Two front doors.** A private listener for static per-client tokens, file uploads and the git webhook. A public listener that only accepts OAuth 2.1 tokens (dynamic client registration and PKCE, sign-in delegated to Forgejo) for remote clients like claude.ai.
- **Attachments.** Binaries go to git LFS with a companion note holding their text (PDFs via `pdftotext`), so they are searchable too.
- **Typed links.** `works_at:: [[acme]]` says what a link means, and `links` can filter by it.
- **Optional search by meaning.** Point `[embeddings]` at any OpenAI-compatible embeddings endpoint (Ollama or llama.cpp on the same CPU, TEI, OpenAI…) and `search` fuses full text with vector similarity, so "car" finds the note that says "vehicle". No model runs inside the server and no GPU is needed; without it, search is full text only.

How it works inside (index, write flow, concurrency, auth): [docs/design.md](docs/design.md).

## Give your agent one link

Once the server is connected to an agent (see [Connecting clients](#connecting-clients)), send it this, and nothing else:

```text
https://raw.githubusercontent.com/PabloPC05/my-memory/main/docs/agent-setup.md
```

The agent reads [the setup guide](docs/agent-setup.md) and installs your memory on its own host: it finds the memory among its tools, proposes importing what it already knows about you, installs standing instructions and, where the host allows it (Claude Code, your own agents), blocks it from saving anywhere else. It asks for one approval before changing anything. Inspired by Notion's agent setup page.

## Tools

| Tool | What it does |
|---|---|
| `list` | Short index, or every note in a folder with description, aliases and last change |
| `search` | Full-text search by section (accents ignored, prefixes match) with snippets; hybrid with search by meaning when `[embeddings]` is set |
| `read` | A note or one section, with its `hash`; `revision` reads an old version |
| `links` | Outgoing `[[links]]` (broken ones included) and backlinks with context, optionally only one relation |
| `history` | Commits that touched a note: who, when, why |
| `clients` | Who is connected: every token and OAuth app with last seen (time and tool), writes in the last 7 and 30 days, and the `memory-setup` version it left in the notes. Never returns secrets |
| `create` | New note; unique names across folders; refuses look-alike duplicates unless `confirm_new` |
| `edit` | Exact text replacements, all or nothing |
| `write` | Rewrite a whole note; needs the `hash` you read |
| `move` | Rename or move; rewrites every `[[link]]` to it in the same commit |
| `delete` | Remove a note (it stays in history); refused while other notes link to it |
| `attach` | Store a file in LFS with a searchable companion note |

Clients with a read-only token only see the first five and `clients`.

The server also offers the agent setup guide to every connected client, offline (it ships with the package): as the MCP prompt `setup` ("Set up this memory on your host") and as the resource `memory://agent-setup`, both with the Markdown of [docs/agent-setup.md](docs/agent-setup.md). The server instructions mention them, so an agent that finds itself on an unconfigured host can follow them without being given the URL.

## Notes format

```markdown
---
name: Universidad
description: Carrera, asignaturas de este curso y cómo las lleva
aliases: [uni, carrera]
---
# Universidad

Text, with links like [[otra-nota]], [[otra-nota#Sección|texto]] or ![[documento.pdf]].
```

File names (without `.md`) must be unique across the repo, so `[[name]]` always resolves; this is what Obsidian does with "shortest path" links.

A link can also say what it means, with [Dataview](https://blacksmithgu.github.io/obsidian-dataview/)-style inline fields: `works_at:: [[acme]]` on its own line, `[lives_with:: [[sam]]]` inside a sentence, or `works_at: "[[acme]]"` in the frontmatter. `links` returns the relation and can filter by it, so "who works at Acme" is one call.

`memory.toml` at the root of the notes repo (every key is optional):

```toml
[folders]
allowed    = ["me", "people", "topics", "projects", "archive"]
archive    = "archive"      # excluded from list/search unless asked
index_full = ["me"]         # listed note by note in the short index
root_files = ["AGENTS.md", "README.md"]

[notes]
required_fields  = ["name", "description"]
filename_pattern = "^[a-z0-9]+(-[a-z0-9]+)*\\.md$"
superseded_field = "superseded_by"
max_description  = 200

[instructions]
file = "AGENTS.md"

[attachments]
page_heading = "Page {n}"

[relations]
allowed = ["works_at", "lives_with"]  # warn on other keys; without it, keys in use are suggested
```

## Running it

Requirements: Node.js 24, git, git-lfs, and poppler's `pdftotext` (optional).

```sh
npm ci && npm run build
my-memory token add laptop --name "Claude Code (laptop)" --scope write --file tokens.toml
my-memory serve --config config.toml
my-memory clients --config config.toml     # who is connected: last seen, writes, setup version (--json for scripts)
```

Last-seen times are kept in `activity.sqlite` in the data dir (written at most once a minute per client; it is not in the notes repo) and the write counts come from the `Client:` trailers of the git history.

`config.toml`:

```toml
data_dir = "/var/lib/my-memory"
public_url = "https://memory.example.com"      # only with the public listener
tokens_file = "tokens.toml"
webhook_secret_file = "webhook-secret"          # paths, or credential:NAME for systemd credentials

[remote]                                        # omit to keep the notes repo local
url = "http://127.0.0.1:3000/me/notes.git"
username = "my-memory"
token_file = "forgejo-token"

[listen.private]
address = "127.0.0.1"
port = 8782

[listen.public]                                 # behind your TLS reverse proxy
address = "127.0.0.1"
port = 8781

[oauth]                                         # required by the public listener
forgejo_url = "https://git.example.com"         # as your browser reaches it
forgejo_internal_url = "http://127.0.0.1:3000"  # as the server reaches it
client_id_file = "oauth-client-id"              # an OAuth2 app registered in Forgejo,
client_secret_file = "oauth-client-secret"      # redirect URI <public_url>/oauth/callback
allowed_users = ["me"]

[embeddings]                                    # optional: search by meaning; omit for full text only
url = "http://127.0.0.1:11434/v1/embeddings"    # any OpenAI-compatible endpoint (Ollama, llama.cpp, TEI, OpenAI…)
model = "nomic-embed-text"
# api_key_file = "embeddings-key"               # sent as a Bearer token, if the endpoint needs one
# dimensions = 512                              # for models that can shorten their output
# batch_size = 32
# timeout_seconds = 60
query_prefix = "search_query: "                 # some models want their inputs marked (nomic, e5)
document_prefix = "search_document: "
```

Uploads for `attach`: `curl -T file.pdf -H "Authorization: Bearer $TOKEN" http://host:8782/uploads/file.pdf` returns an `upload_id`. There is no size limit.

### NixOS

```nix
{
  inputs.my-memory.url = "github:<owner>/my-memory";
  # in your configuration:
  imports = [ inputs.my-memory.nixosModules.default ];
  services.my-memory = {
    enable = true;
    remote = { url = "http://127.0.0.1:3000/me/notes.git"; tokenFile = "/run/secrets/forgejo-token"; };
    listen.private = { address = "127.0.0.1"; port = 8782; };
    tokensFile = "/var/lib/secrets/my-memory/tokens.toml";   # root:my-memory 0640
  };
}
```

After `my-memory token add … --file <tokensFile>`, run `systemctl reload my-memory`.

For search by meaning, add `embeddings = { url = "http://127.0.0.1:11434/v1/embeddings"; model = "nomic-embed-text"; queryPrefix = "search_query: "; documentPrefix = "search_document: "; };` (with `apiKeyFile` if the endpoint needs a key), for example next to `services.ollama`.

### Search by meaning

With `[embeddings]`, every section of every note gets a vector from the endpoint, stored in `index.sqlite`. `search` then takes `mode`: `hybrid` (default) fuses the full-text ranking and the vector ranking with Reciprocal Rank Fusion, `text` is the plain full-text search, `semantic` uses vectors only. The answer has the same shape as always.

- **Writes never wait for it.** Sections are embedded in the background after each commit or sync; until then they are found by text. Only sections whose text changed are embedded again, and changing `model`, `dimensions` or `document_prefix` embeds everything again.
- **If the endpoint is down**, writes work as usual, search falls back to full text with a warning in the log, and pending sections are retried with backoff.
- **Status in the log:** `embeddings.status` at startup (model, vectors, sections pending), `embeddings.done` after each run, `embeddings.failed` while the endpoint fails.
- `my-memory reindex` also embeds the sections that are missing; `--reembed` embeds them all again. With a `credential:` key it cannot read outside systemd, it skips embedding and the service does it when it starts.
- On a small CPU-only server, Ollama with `nomic-embed-text` (multilingual: `bge-m3` or `multilingual-e5-small`, the e5 ones with prefixes `query: ` and `passage: `) embeds a few thousand sections in minutes, once.

### Connecting clients

```sh
# Claude Code
claude mcp add --transport http memory http://host:8782/mcp --header "Authorization: Bearer $MY_MEMORY_TOKEN"
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.memory]
url = "http://host:8782/mcp"
bearer_token_env_var = "MY_MEMORY_TOKEN"
```

claude.ai: Settings → Connectors → Add custom connector → `https://memory.example.com/mcp`.

Then give the agent the setup link ([Give your agent one link](#give-your-agent-one-link)).

### One credential per agent

my-memory attributes every write (the git commit author and its `Client:` trailer), every log line and the `clients` view to the credential the request used. So **each agent must connect with its own credential**. If two agents share one, nobody can tell who wrote what, `clients` cannot tell them apart, and a leaked key cannot be revoked without cutting off the other agent too.

- **Static tokens:** create one per agent and never share it: `my-memory token add <id> --name "<Agent name>" --scope write|read --file tokens.toml`. OAuth clients (for example claude.ai connecting directly) get their own identity automatically.
- **Behind a gateway or proxy** that joins several MCP servers into one endpoint, the gateway is the client my-memory sees. Give the gateway one key per agent and map each key to its own my-memory token (same public URL, a different key per agent); otherwise every write shows the gateway's name. This pattern has been done with Caddy plus agentgateway, but any gateway that can pick the upstream credential from the incoming key works.
- **Check it:** run `my-memory clients` or call the `clients` tool. Each agent must appear on its own row, with its last activity and its writes.

### Moving an existing repo to wikilinks

`my-memory migrate <clone>` shows what would change: relative Markdown links become `[[wikilinks]]`, name collisions are renamed, and frontmatter that is not valid YAML gets quoted. Add `--apply` to commit it. Only those spans change.

## Development

```sh
npm ci
npm test          # vitest: unit, integration (real git repos) and HTTP/OAuth end to end
npm run typecheck
nix flake check   # builds the package and runs the NixOS VM test
```

## License

Apache-2.0.
