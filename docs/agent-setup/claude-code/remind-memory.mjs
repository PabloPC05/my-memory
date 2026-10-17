// Claude Code UserPromptSubmit hook: when the user's message talks about saving or remembering something, add a
// reminder to that turn that "memory" means my-memory (a note there, not a local file). Installed by the agent
// setup guide (docs/agent-setup.md, step 4c). Instructions alone were not enough: asked for "a markdown in my
// memory", an agent wrote a local file.
//
// settings.json:
//   "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "node",
//     "args": ["<home>/.claude/hooks/remind-memory.mjs"] } ] } ] }
//
// MEMORY_MCP_HINT (optional) names the server and tools, e.g. "the MCP server lisa (memoria_search, memoria_create,
// memoria_edit)". The trigger covers English and Spanish; extend it for other languages.
const hint =
  process.env.MEMORY_MCP_HINT ||
  "the my-memory MCP server (search, then create or edit; the tools may carry a prefix such as memoria_)";

export const trigger = new RegExp(
  [
    String.raw`\bmemor(y|ies|ia|ias)\b`,
    String.raw`\bremember (this|that|it)\b`,
    String.raw`\b(save|note|keep) (this|that|it)\b`,
    String.raw`\bap[uú]nta(lo|la|los|las|me|melo|mela)?\b`,
    String.raw`\bgu[aá]rda(lo|la|los|las|melo|mela)\b`,
    String.raw`\brecu[eé]rda(lo|la|melo|mela)\b`,
    String.raw`\btenlo accesible\b`,
    String.raw`\bno (lo|la) olvides\b`,
  ].join("|"),
  "i",
);

export function reminderFor(prompt) {
  if (!trigger.test(String(prompt ?? ""))) return null;
  return (
    `The user's message mentions saving or remembering. "Memory" / "my memory" means ${hint}. Anything they want ` +
    "kept there, including a document, a list or a Markdown file, is a note created there (notes are Markdown), " +
    "filed where its AGENTS.md says (a project's material with that project). Do not write it as a local file " +
    "unless they explicitly ask for a file. If that server is unavailable, tell them instead of saving it elsewhere."
  );
}

function main() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    let prompt;
    try {
      prompt = JSON.parse(input).prompt;
    } catch {
      return;
    }
    const text = reminderFor(prompt);
    if (!text) return;
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }),
    );
  });
}

// Runs as a hook; with NODE_TEST set it only exports the checks, for tests.
if (!process.env.NODE_TEST) main();
