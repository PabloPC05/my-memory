// node docs/agent-setup/claude-code/remind-memory.test.mjs
process.env.NODE_TEST = "1";
const { reminderFor } = await import("./remind-memory.mjs");

const cases = [
  ["make me a markdown with all the open questions and put it in my memory", true],
  ["remember this: the car is due for service in April", true],
  ["save it where it belongs", true],
  ["hazme un markdown con todas las preguntas y mete todo esto en mi memoria para tenerlo accesible", true],
  ["apúntalo, porfa", true],
  ["guárdalo en la carpeta del proyecto", true],
  ["fix the login bug", false],
  ["esto es un memorándum para la empresa", false],
  ["the memoir chapter needs editing", false],
];
let fail = 0;
for (const [prompt, want] of cases) if (Boolean(reminderFor(prompt)) !== want) (fail++, console.log("FAIL:", prompt));
console.log(fail ? `${fail} failed` : `ok (${cases.length} cases)`);
process.exit(fail ? 1 : 0);
