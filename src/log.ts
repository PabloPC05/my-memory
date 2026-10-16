export type Level = "debug" | "info" | "warn" | "error";

export type Logger = (level: Level, event: string, fields?: Record<string, unknown>) => void;

/** One JSON line per event on stdout (journald picks it up). Never pass note content or tokens here. */
export function jsonLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`), minLevel: Level = "info"): Logger {
	const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
	return (level, event, fields = {}) => {
		if (order[level] < order[minLevel]) return;
		write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
	};
}

export const silentLogger: Logger = () => undefined;
