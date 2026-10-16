#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on Node 24; it is the only one we expect.
process.removeAllListeners("warning");
process.on("warning", (w) => {
	if (w.name === "ExperimentalWarning" && /SQLite/.test(w.message)) return;
	console.error(w);
});
const { main } = await import("../dist/cli.js");
process.exitCode = await main(process.argv.slice(2));
