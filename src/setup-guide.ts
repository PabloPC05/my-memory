import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SETUP_GUIDE_URI = "memory://agent-setup";
export const SETUP_GUIDE_URL = "https://raw.githubusercontent.com/PabloPC05/my-memory/main/docs/agent-setup.md";

/** `docs/agent-setup.md` sits one level above both `src/` and `dist/`, in the repo and in the installed package. */
const BUNDLED = fileURLToPath(new URL("../docs/agent-setup.md", import.meta.url));

let cached: string | null | undefined;

/** The agent setup guide shipped with the package, so it is served offline. Null if the file is missing (broken install). */
export function setupGuide(path: string = BUNDLED): string | null {
	if (path !== BUNDLED) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	}
	if (cached === undefined) {
		try {
			cached = readFileSync(BUNDLED, "utf8");
		} catch {
			cached = null;
		}
	}
	return cached;
}
