// node docs/agent-setup/claude-code/block-native-memory.test.mjs
process.env.NODE_TEST = "1";
const { shellWritesMemory, fileIsMemory } = await import("./block-native-memory.mjs");

const shell = [
  ["echo hola >> ~/.claude/projects/C--Users-pablo/memory/MEMORY.md", true],
  ["cat > /c/Users/pablo/.claude/projects/x/memory/a.md <<EOF", true],
  ["rm -f ~/.claude/projects/x/memory/a.md", true],
  ["Set-Content C:\\Users\\pablo\\.claude\\projects\\x\\memory\\a.md hola", true],
  ["cp nota.md ~/.claude/projects/x/memory/", true],
  ["echo x | tee ~/.claude/projects/x/memory/a.md", true],
  ["cat ~/.claude/projects/x/memory/MEMORY.md", false],
  ["ls ~/.claude/projects/x/memory/; rm -f /tmp/otro.json", false],
  ['gh pr create --body "refuses writes to ~/.claude/projects/*/memory/ (Bash)" > /dev/null', false],
  ['git commit -m "block ~/.claude/projects/*/memory/" && git push 2>&1 | tail -1', false],
];
const files = [
  ["C:\\Users\\pablo\\.claude\\projects\\C--Users-pablo\\memory\\nota.md", true],
  ["/home/x/.claude/projects/p/memory/MEMORY.md", true],
  ["C:/Users/pablo/lisa/notas.md", false],
];
let fail = 0;
for (const [c, want] of shell) if (shellWritesMemory(c) !== want) (fail++, console.log("FAIL shell:", c));
for (const [p, want] of files) if (fileIsMemory(p) !== want) (fail++, console.log("FAIL file:", p));
console.log(fail ? `${fail} failed` : `ok (${shell.length + files.length} cases)`);
process.exit(fail ? 1 : 0);
