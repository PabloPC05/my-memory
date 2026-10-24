# my-memory

Una memoria autoalojada para agentes de IA. Tus notas son una carpeta de Markdown en git; my-memory las sirve por [MCP](https://modelcontextprotocol.io) para que cualquier agente (Claude Code, Codex, claude.ai, tus propios bots) pueda buscarlas, leerlas y escribirlas. Cada escritura es un commit atribuido al cliente que la hizo.

*[Read in English](README.md)*

> Mantén este archivo y [README.md](README.md) sincronizados: cuando edites uno, actualiza el otro.

- **Git es la fuente de verdad.** La búsqueda va sobre un índice SQLite (catálogo, texto completo FTS5 por secciones, wikilinks) que se puede reconstruir desde git en cualquier momento.
- **Un commit por escritura**, con el cliente como autor: `Claude Code (laptop)`, `Alex (Claude)`… El mensaje del commit es el motivo que dio el agente, más los trailers `Client:` / `Tool:` / `Session:`.
- **Seguro con varios agentes a la vez.** Una sola cola de escritura, concurrencia optimista (el `hash` de `read`) y los pushes de fuera (tu PC, el editor web de Forgejo) se integran con rebase.
- **Tus convenciones, no las nuestras.** El repo de notas declara sus carpetas, su frontmatter obligatorio y sus reglas de nombres en `memory.toml`; su `AGENTS.md` llega a todos los clientes como instrucciones MCP, junto con un índice corto.
- **Dos puertas de entrada.** Un listener privado para tokens fijos por cliente, subida de archivos y el webhook de git. Un listener público que solo acepta tokens OAuth 2.1 (registro dinámico de clientes y PKCE, con el inicio de sesión delegado en Forgejo) para clientes remotos como claude.ai.
- **Adjuntos.** Los binarios van a git LFS con una nota al lado que contiene su texto (los PDF, con `pdftotext`; los PDF escaneados y las imágenes, con OCR local mediante `tesseract` si está instalado), así que también se encuentran al buscar.
- **Enlaces con tipo.** `works_at:: [[acme]]` dice qué significa un enlace, y `links` puede filtrar por él.
- **Búsqueda por significado, opcional.** Apunta `[embeddings]` a cualquier endpoint de embeddings compatible con OpenAI (Ollama o llama.cpp en la misma CPU, TEI, OpenAI…) y `search` combina el texto completo con la similitud de vectores, así que «coche» encuentra la nota que dice «vehículo». Dentro del servidor no corre ningún modelo y no hace falta GPU; sin él, la búsqueda es solo de texto completo.
- **También tus archivos.** Conecta tu Google Drive y los agentes buscan en él por nombre al instante (un índice en memoria, como FSearch) o por contenido (el índice de texto de Drive), y leen cualquier archivo.
- **Una carpeta de fuentes que alimenta la memoria.** Deja un documento en la carpeta de Drive que elijas y un agente que tú configuras (Claude, cualquier modelo compatible con OpenAI o un webhook tuyo) lo lee y actualiza las notas, citándolo por su ID de Drive. También sigue las versiones nuevas y los borrados.
- **Seguir un tema en otro agente.** `resume` da el estado de un tema (qué se está haciendo, qué viene después) y lo que cambió desde tu última visita, en una llamada barata, para dejar un chat y seguir en otro.
- **Sin servidor.** Las notas en un repositorio privado de GitHub, los archivos en Google Drive y el servidor como una función de Vercel: [docs/deploy-vercel.md](docs/deploy-vercel.md) (en inglés).

Cómo funciona por dentro (índice, flujo de escritura, concurrencia, autenticación): [docs/design.md](docs/design.md).

## Dale a tu agente un enlace

Una vez que el servidor está conectado a un agente (mira [Conectar clientes](#conectar-clientes)), mándale esto y nada más:

```text
https://raw.githubusercontent.com/PabloPC05/my-memory/main/docs/agent-setup.md
```

El agente lee [la guía de instalación](docs/agent-setup.md) y se instala tu memoria él solo en su plataforma: la encuentra entre sus herramientas, te propone importar lo que ya sabe de ti, instala sus instrucciones permanentes y, donde la plataforma lo permite (Claude Code, tus propios agentes), le impide guardar en cualquier otro sitio. Te pide un único permiso antes de cambiar nada. Inspirado en la página de instalación para agentes de Notion.

En Claude Code también puede instalar, si quieres, un hook que le acerca al agente las notas relevantes sin que tenga que acordarse de buscar (como hace Supermemory): antes de cada mensaje, [`inject-memory.mjs`](docs/agent-setup/claude-code/inject-memory.mjs) busca ese mensaje en tu memoria y añade al turno las mejores coincidencias, presentadas como información que comprobar, no como instrucciones, y con un límite de tamaño pequeño. Necesita `MY_MEMORY_URL` y un `MY_MEMORY_TOKEN` de solo lectura, y no añade nada ante cualquier error o tiempo de espera agotado.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `list` | Índice corto, o todas las notas de una carpeta con descripción, alias y último cambio |
| `search` | Búsqueda de texto completo por secciones (sin distinguir acentos, los prefijos coinciden) con fragmentos; híbrida con búsqueda por significado si hay `[embeddings]` |
| `read` | Una nota o una sección, con su `hash`; `revision` lee una versión antigua |
| `links` | Enlaces `[[...]]` salientes (también los rotos) y retroenlaces con contexto, opcionalmente solo una relación |
| `history` | Commits que tocaron una nota: quién, cuándo, por qué |
| `recent` | Últimos cambios de toda la memoria: por commit cuándo, quién (autor y cliente), herramienta, motivo y las notas que tocó; filtros `since` (`2026-05-01` o `7d`), `folder`, `client` |
| `lint` | Lista de mantenimiento, lo más grave primero: frontmatter roto y notas sustituidas fuera del archivo, enlaces rotos, posibles duplicados, deducciones antiguas, páginas que faltan, menciones sin enlace, notas huérfanas, sin tocar hace mucho o demasiado grandes. Cuenta por tipo; filtra por `kinds`, `folder` y `limit` |
| `clients` | Quién está conectado: cada token y app OAuth con su última conexión (hora y herramienta), escrituras en los últimos 7 y 30 días y la versión de `memory-setup` que dejó anotada en las notas. Nunca devuelve secretos |
| `create` | Nota nueva; nombres únicos entre carpetas; rechaza duplicados parecidos salvo `confirm_new` |
| `edit` | Reemplazos de texto exactos, todos o ninguno |
| `write` | Reescribe una nota entera; necesita el `hash` que leíste |
| `move` | Renombra o mueve; reescribe todos los `[[enlaces]]` a ella en el mismo commit |
| `delete` | Borra una nota (queda en el historial); se rechaza mientras otras notas la enlacen |
| `revert` | Deshace un commit de `recent`/`history` con un commit nuevo, o solo lo que hizo en una nota; conserva los cambios posteriores que no se solapan y si no, se rechaza con `REVERT_CONFLICT` |
| `attach` | Guarda un archivo en LFS con una nota al lado en la que se puede buscar |
| `resume` | Retoma un tema: la descripción de su nota, sus secciones de estado enteras (`[resume] sections` en `memory.toml`), los últimos cambios y solo los títulos del resto; `since` para lo que cambió desde tu última visita |
| `files_search` | Tu Drive (si hay `[drive]`): por nombre desde memoria, al instante, o `content: true` para el índice de texto de Drive |
| `files_read` | El texto de un archivo (texto, Docs/Hojas/Presentaciones de Google, Word) o el archivo entero (PDF, imágenes…) |
| `files_info` | Nombre, ruta, tipo, tamaño, fecha y enlace de un archivo por su ID (`source:<id>` en las notas) |

Los clientes con un token de solo lectura ven solo las herramientas de lectura: `list`, `search`, `read`, `links`, `history`, `recent`, `resume`, `lint`, `clients` y las `files_*`.

`lint` es la mitad barata de mantener la memoria en orden (la «wiki para LLM» de Karpathy: ingerir, responder, revisar). Sale del índice y de las fechas de git en milisegundos, sin modelo, así que el agente recibe candidatos en vez de leerse todas las notas; juzgarlos (¿es una contradicción?, ¿sigue valiendo esa deducción?, ¿fusionar o enlazar?) es la mitad del agente. Más en [docs/design.md](docs/design.md#lint).

El servidor también ofrece la guía de instalación para agentes a todo cliente conectado, sin conexión (va dentro del paquete): como prompt MCP `setup` («Set up this memory on your host») y como recurso `memory://agent-setup`, ambos con el Markdown de [docs/agent-setup.md](docs/agent-setup.md). Las instrucciones del servidor los mencionan, así que un agente que se encuentre en una plataforma sin configurar puede seguirlos sin que le des la URL.

## Formato de las notas

```markdown
---
name: Universidad
description: Carrera, asignaturas de este curso y cómo las lleva
aliases: [uni, carrera]
---
# Universidad

Texto, con enlaces como [[otra-nota]], [[otra-nota#Sección|texto]] o ![[documento.pdf]].
```

Los nombres de archivo (sin `.md`) tienen que ser únicos en todo el repo, de modo que `[[nombre]]` siempre se resuelve; es lo que hace Obsidian con los enlaces de «ruta más corta».

Un enlace también puede decir qué significa, con campos en línea al estilo [Dataview](https://blacksmithgu.github.io/obsidian-dataview/): `works_at:: [[acme]]` en su propia línea, `[lives_with:: [[sam]]]` dentro de una frase, o `works_at: "[[acme]]"` en el frontmatter. `links` devuelve la relación y puede filtrar por ella, así que «quién trabaja en Acme» es una sola llamada.

`memory.toml` en la raíz del repo de notas (todas las claves son opcionales):

```toml
[folders]
allowed    = ["me", "people", "topics", "projects", "archive"]
archive    = "archive"      # excluida de list/search salvo que se pida
index_full = ["me"]         # listadas nota por nota en el índice corto
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
ocr_notice   = "Text recognised with OCR ({languages}); it may contain errors."

[relations]
allowed = ["works_at", "lives_with"]  # avisa con otras claves; sin esto, se sugieren las que estén en uso

[lint]
exclude            = []            # carpetas que no se revisan (la raíz y la carpeta de archivo nunca se revisan)
orphan_exclude     = ["me"]        # nunca se avisan como huérfanas; por defecto, folders.index_full
stale_days         = 180           # sin cambios más tiempo → stale
inference_days     = 90            # «(deducido, 2026-01-31)» más antiguo → old_inference
inferred_markers   = ["deducido"]  # palabras de procedencia que marcan una deducción
max_bytes          = 16384         # más grande → oversized (las notas de adjuntos no cuentan)
missing_page_min   = 2             # un destino que no existe enlazado desde tantas notas → missing_page
mention_min_length = 4             # nombre o alias más corto que se busca como mención sin enlace
```

## Ponerlo en marcha

Requisitos: Node.js 24, git, git-lfs y, de forma opcional, poppler-utils (`pdftotext` para el texto de los PDF y `pdftoppm` para el OCR de escaneos) y `tesseract` con los idiomas que quieras (para el OCR de PDF escaneados e imágenes). Al arrancar se registra qué herramientas hay (`ocr.tools` en el log); si falta alguna, solo deja de estar disponible esa extracción.

```sh
npm ci && npm run build
my-memory token add laptop --name "Claude Code (laptop)" --scope write --file tokens.toml
my-memory serve --config config.toml
my-memory clients --config config.toml     # quién está conectado: última conexión, escrituras, versión de la guía (--json para scripts)
my-memory lint --config config.toml        # lista de mantenimiento (--json, --kind stale,orphan, --folder, --limit)
```

Las horas de última conexión se guardan en `activity.sqlite`, en el directorio de datos (como mucho una vez por minuto y cliente; no está en el repo de notas), y el número de escrituras sale de los trailers `Client:` del historial de git.

`config.toml`:

```toml
data_dir = "/var/lib/my-memory"
public_url = "https://memory.example.com"      # solo con el listener público
tokens_file = "tokens.toml"
webhook_secret_file = "webhook-secret"          # rutas, o credential:NOMBRE para credenciales de systemd

[remote]                                        # omítelo para dejar el repo de notas en local
url = "http://127.0.0.1:3000/me/notes.git"
username = "my-memory"
token_file = "forgejo-token"

[listen.private]
address = "127.0.0.1"
port = 8782

[listen.public]                                 # detrás de tu proxy inverso con TLS
address = "127.0.0.1"
port = 8781

[oauth]                                         # obligatorio con el listener público
forgejo_url = "https://git.example.com"         # como lo ve tu navegador
forgejo_internal_url = "http://127.0.0.1:3000"  # como lo ve el servidor
client_id_file = "oauth-client-id"              # una app OAuth2 registrada en Forgejo,
client_secret_file = "oauth-client-secret"      # URI de redirección <public_url>/oauth/callback
allowed_users = ["me"]

[ocr]                                           # todas las claves son opcionales
enabled = true
languages = "spa+eng"                           # códigos de idioma de tesseract; por defecto "eng"
max_pages = 50                                  # páginas de un PDF escaneado que pasan por OCR
page_timeout_seconds = 120                      # por página (render + reconocimiento) o imagen
# dpi = 300; tesseract = "tesseract"; pdftoppm = "pdftoppm"

[embeddings]                                    # opcional: búsqueda por significado; omítelo para solo texto completo
url = "http://127.0.0.1:11434/v1/embeddings"    # cualquier endpoint compatible con OpenAI (Ollama, llama.cpp, TEI, OpenAI…)
model = "nomic-embed-text"
# api_key_file = "embeddings-key"               # se envía como token Bearer, si el endpoint lo pide
# dimensions = 512                              # para modelos que pueden acortar su salida
# batch_size = 32
# timeout_seconds = 60
query_prefix = "search_query: "                 # algunos modelos quieren marcadas sus entradas (nomic, e5)
document_prefix = "search_document: "

[drive]                                         # opcional: tu Google Drive como archivos (el token, en docs/deploy-vercel.md)
client_id = "…apps.googleusercontent.com"
client_secret_file = "google-client-secret"
refresh_token_file = "google-refresh-token"     # permisos drive.readonly (+ drive.appdata para arrancar rápido)
sources_folder = "Memoria/Fuentes"              # opcional: lo que haya aquí alimenta la memoria
# check_interval_seconds = 60                   # cada cuánto se miran los cambios de Drive y se ingieren las fuentes
# push_token_file = "drive-push-token"          # avisos de Drive a <public_url>/hooks/drive

[ingest]                                        # opcional: el agente que lee la carpeta de fuentes
provider = "anthropic"                          # anthropic | openai (cualquier API compatible) | webhook
api_key_file = "anthropic-key"
# model = "claude-opus-5-5"; base_url = "…"; webhook_url = "…"; webhook_secret_file = "…"
# max_files_per_run = 3; max_steps = 30
```

Subidas para `attach`: `curl -T file.pdf -H "Authorization: Bearer $TOKEN" http://host:8782/uploads/file.pdf` devuelve un `upload_id`. No hay límite de tamaño.

### NixOS

```nix
{
  inputs.my-memory.url = "github:<owner>/my-memory";
  # en tu configuración:
  imports = [ inputs.my-memory.nixosModules.default ];
  services.my-memory = {
    enable = true;
    remote = { url = "http://127.0.0.1:3000/me/notes.git"; tokenFile = "/run/secrets/forgejo-token"; };
    listen.private = { address = "127.0.0.1"; port = 8782; };
    tokensFile = "/var/lib/secrets/my-memory/tokens.toml";   # root:my-memory 0640
    # ocr = { enable = true; languages = [ "spa" "eng" ]; maxPages = 50; pageTimeoutSeconds = 120; dpi = 300; };
  };
}
```

Tras `my-memory token add … --file <tokensFile>`, ejecuta `systemctl reload my-memory`. El paquete trae pdftotext, pdftoppm y tesseract; el módulo instala los datos de los idiomas de `ocr.languages` (por defecto español e inglés), y solo compila ese tesseract con `ocr.enable` activado.

Para la búsqueda por significado, añade `embeddings = { url = "http://127.0.0.1:11434/v1/embeddings"; model = "nomic-embed-text"; queryPrefix = "search_query: "; documentPrefix = "search_document: "; };` (con `apiKeyFile` si el endpoint pide clave), por ejemplo junto a `services.ollama`.

### Búsqueda por significado

Con `[embeddings]`, cada sección de cada nota recibe un vector del endpoint, que se guarda en `index.sqlite`. Entonces `search` acepta `mode`: `hybrid` (por defecto) combina el ranking de texto completo y el de vectores con Reciprocal Rank Fusion, `text` es la búsqueda de texto completo de siempre y `semantic` usa solo los vectores. La respuesta tiene la misma forma de siempre.

- **Las escrituras nunca lo esperan.** Las secciones se procesan en segundo plano después de cada commit o sincronización; mientras tanto se encuentran por texto. Solo se vuelven a procesar las secciones cuyo texto cambió, y cambiar `model`, `dimensions` o `document_prefix` las procesa todas otra vez.
- **Si el endpoint está caído**, las escrituras funcionan como siempre, la búsqueda vuelve al texto completo con un aviso en el log y las secciones pendientes se reintentan con espera creciente.
- **Estado en el log:** `embeddings.status` al arrancar (modelo, vectores, secciones pendientes), `embeddings.done` tras cada pasada y `embeddings.failed` mientras el endpoint falla.
- `my-memory reindex` también procesa las secciones que falten; `--reembed` las procesa todas otra vez. Con una clave `credential:` que no puede leer fuera de systemd, se salta los embeddings y los hace el servicio al arrancar.
- En un servidor pequeño sin GPU, Ollama con `nomic-embed-text` (multilingües: `bge-m3` o `multilingual-e5-small`, los e5 con los prefijos `query: ` y `passage: `) procesa unos miles de secciones en minutos, una sola vez.

### Conectar clientes

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

claude.ai: Ajustes → Conectores → Añadir conector personalizado → `https://memory.example.com/mcp`.

Después dale al agente el enlace de instalación ([Dale a tu agente un enlace](#dale-a-tu-agente-un-enlace)).

### Una credencial por agente

my-memory atribuye cada escritura (el autor del commit de git y su trailer `Client:`), cada línea de log y la vista `clients` a la credencial con la que llegó la petición. Por eso **cada agente debe conectarse con su propia credencial**. Si dos agentes comparten una, nadie puede saber quién escribió qué, `clients` no los distingue y una clave filtrada no se puede revocar sin cortar también al otro agente.

- **Tokens fijos:** crea uno por agente y no lo compartas nunca: `my-memory token add <id> --name "<Nombre del agente>" --scope write|read --file tokens.toml`. Los clientes OAuth (por ejemplo claude.ai conectando directamente) reciben su propia identidad automáticamente.
- **Detrás de una pasarela o proxy** que une varios servidores MCP en un único endpoint, el cliente que ve my-memory es la pasarela. Dale a la pasarela una clave por agente y asocia cada clave a su propio token de my-memory (misma URL pública, una clave distinta por agente); si no, todas las escrituras aparecen con el nombre de la pasarela. Este patrón se ha hecho con Caddy más agentgateway, pero vale cualquier pasarela que pueda elegir la credencial hacia el servidor a partir de la clave de entrada.
- **Compruébalo:** ejecuta `my-memory clients` o llama a la herramienta `clients`. Cada agente debe aparecer en su propia fila, con su última actividad y sus escrituras.

### Pasar un repo existente a wikilinks

`my-memory migrate <clone>` muestra lo que cambiaría: los enlaces Markdown relativos pasan a `[[wikilinks]]`, las colisiones de nombres se renombran y el frontmatter que no es YAML válido se entrecomilla. Añade `--apply` para hacer el commit. Solo cambian esos fragmentos.

## Desarrollo

```sh
npm ci
npm test          # vitest: unitarias, de integración (repos git reales) y extremo a extremo HTTP/OAuth
npm run typecheck
nix flake check   # compila el paquete y ejecuta el test de la VM de NixOS
```

## Licencia

Apache-2.0.
