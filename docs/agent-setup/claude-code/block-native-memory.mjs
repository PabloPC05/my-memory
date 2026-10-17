// Claude Code PreToolUse hook: refuse writes to Claude Code's own memory (~/.claude/projects/*/memory/), so durable
// knowledge goes to my-memory instead. Installed by the agent setup guide (docs/agent-setup.md, step 4c).
//
// settings.json:
//   "hooks": { "PreToolUse": [ { "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell",
//     "hooks": [ { "type": "command", "command": "node", "args": ["<home>/.claude/hooks/block-native-memory.mjs"] } ] } ] }
//
// MEMORY_MCP_HINT (optional) replaces the tool hint in the message, e.g. "the MCP server lisa (memoria_search,
// memoria_create, memoria_edit)". Reading the folder, or merely mentioning it, is allowed; only writes are refused.
const hint =
  process.env.MEMORY_MCP_HINT ||
  "the my-memory MCP server (search, then create or edit; the tools may carry a prefix such as memoria_)";

const memoryPath = String.raw`[^\s"'|;&<>]*\.claude/projects/[^/\s"'|;&<>]+/memory(?:/[^\s"'|;&<>]*)?`;
const memoryDir = new RegExp(memoryPath);
// `> path` or `>> path` pointing into the folder.
const redirectInto = new RegExp(String.raw`(?:^|[^<])>{1,2}\s*["']?` + memoryPath);
// A command that creates, changes or deletes files, at the start of a simple command.
const writeCommand =
  /^\s*(?:sudo\s+|env\s+\S+\s+)*(?:cp|mv|rm|tee|touch|mkdir|rmdir|ln|install|truncate|sed\s+-i\S*|perl\s+-[a-z]*i|out-file|set-content|add-content|new-item|remove-item|copy-item|move-item|rename-item|clear-content)\b/;

const norm = (s) => String(s ?? "").replaceAll("\\", "/").toLowerCase();

export function shellWritesMemory(command) {
  return norm(command)
    .split(/\n|;|&&|\|\||\|/)
    .some((part) => redirectInto.test(part) || (writeCommand.test(part) && memoryDir.test(part)));
}

export function fileIsMemory(path) {
  return memoryDir.test(norm(path));
}

function main() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    let call;
    try {
      call = JSON.parse(input);
    } catch {
      return; // nothing to check
    }
    const tool = call.tool_name ?? "";
    const args = call.tool_input ?? {};
    const block = ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)
      ? fileIsMemory(args.file_path ?? args.notebook_path)
      : tool === "Bash" || tool === "PowerShell"
        ? shellWritesMemory(args.command)
        : false;
    if (!block) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `Claude Code's own memory is switched off for this user. Save durable knowledge in ${hint}, following ` +
            "the rules in its AGENTS.md (sent as the server's instructions). If that server is unavailable, tell " +
            "the user instead of saving it anywhere else.",
        },
      }),
    );
  });
}

// Runs as a hook; with NODE_TEST set it only exports the checks, for tests.
if (!process.env.NODE_TEST) main();
