# my-memory

Una memoria autoalojada para agentes de IA. Tus notas son una carpeta de Markdown en git, y my-memory las sirve por [MCP](https://modelcontextprotocol.io) para que cualquier agente (Claude Code, Codex, claude.ai o tus propios bots) pueda buscarlas, leerlas y escribirlas. Cada escritura es un commit firmado por el cliente que la hizo.

*[Read in English](README.md)*

- **Git es la fuente de verdad.** La búsqueda va sobre un índice SQLite (catálogo, texto completo FTS5 por secciones y wikilinks) que se reconstruye desde git cuando haga falta.
- **Un commit por escritura**, con el cliente como autor. El mensaje es el motivo que da el agente, con trailers `Client:`, `Tool:` y `Session:`.
- **Varios agentes a la vez.** Las escrituras van en cola, se usa concurrencia optimista (el `hash` de `read`) y los pushes de fuera se integran con rebase.
- **Tus convenciones.** El repo de notas declara sus carpetas, su frontmatter obligatorio y su patrón de nombres en `memory.toml`. Su `AGENTS.md` llega a todos los clientes como instrucciones MCP, junto con un índice corto.
- **Dos puertas de entrada.**
  - Una privada, para los tokens fijos de cada cliente, la subida de archivos y el webhook de git.
  - Una pública, que solo acepta tokens OAuth 2.1 (registro dinámico de clientes y PKCE, con el inicio de sesión delegado en Forgejo), para clientes remotos como claude.ai.
- **Relaciones con tipo.** Un enlace puede decir qué significa, con campos al estilo Dataview: `trabaja_en:: [[empresa-x]]`. `links` devuelve la relación y filtra por ella.
- **Adjuntos.** Los binarios van a git LFS con una nota al lado que contiene su texto (el de los PDF se saca con `pdftotext`), así que también se encuentran al buscar.

Las herramientas, la configuración, el módulo de NixOS y cómo conectar cada cliente están en el [README en inglés](README.md); cómo funciona por dentro, en [docs/design.md](docs/design.md).

Licencia Apache-2.0.
