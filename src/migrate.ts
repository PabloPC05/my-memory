import { readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parseNote, splitFrontmatter } from "./frontmatter.js";
import { parse as parseYaml } from "yaml";
import { defaultConventions } from "./conventions.js";
import { Git } from "./git.js";
import { lineAt, lineOffsets, maskCode, parseWikiLinks } from "./markdown.js";
import { dirOf, joinPath, normalizeWords, noteName } from "./util.js";

export interface LinkIssue {
	file: string;
	line: number;
	link: string;
	why: string;
}

export interface MigrationPlan {
	renames: { from: string; to: string }[];
	/** Notes whose frontmatter needed quotes to become valid YAML. */
	frontmatterFixed: string[];
	files: { path: string; converted: number; content: string; changed: boolean }[];
	converted: number;
	issues: LinkIssue[];
	/** Wikilinks that will not resolve after the migration (pre-existing or produced). */
	broken: LinkIssue[];
	notes: number;
}

const MD_LINK = /(!?)\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

function validYaml(text: string): boolean {
	try {
		parseYaml(text, { schema: "core", uniqueKeys: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Quotes plain `key: value` lines that strict YAML rejects (a value containing «: » is the usual case),
 * leaving every other line as it is. Returns null when nothing needed fixing or it could not be fixed.
 */
export function quoteFrontmatter(text: string): string | null {
	const split = splitFrontmatter(text);
	if (split.yaml === null || validYaml(split.yaml)) return null;
	const fixed = split.yaml
		.split("\n")
		.map((line) => {
			const m = /^([A-Za-z_][\w-]*):[ \t]+(.+?)\r?$/.exec(line);
			if (!m) return line;
			const value = m[2] as string;
			if (/^["'[{>|&*!]/.test(value) || validYaml(`k: ${value}`)) return line;
			return `${m[1]}: ${JSON.stringify(value)}`;
		})
		.join("\n");
	if (!validYaml(fixed)) return null;
	const start = text.indexOf(split.yaml);
	return text.slice(0, start) + fixed + text.slice(start + split.yaml.length);
}

/** GitHub-style heading anchor, which is what relative links in the old repo used. */
export function slugify(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
}

function headingsOf(text: string): string[] {
	const out: string[] = [];
	for (const line of maskCode(text).split("\n")) {
		const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/.exec(line);
		if (m?.[1]) out.push(m[1].trim());
	}
	return out;
}

/**
 * Plans the move from relative Markdown links to [[wikilinks]] with unique names.
 * Only the link spans change; name collisions are solved by renaming the deeper file.
 */
export async function planMigration(repoDir: string): Promise<MigrationPlan> {
	const git = new Git(repoDir);
	const tracked = (await git.out(["ls-files", "-z"])).split("\0").filter(Boolean);
	const trackedSet = new Set(tracked);
	const md = tracked.filter((p) => p.toLowerCase().endsWith(".md"));
	const texts = new Map<string, string>();
	for (const p of md) texts.set(p, await readFile(join(repoDir, p), "utf8"));

	// Unique names: within each colliding group, the shallowest path keeps its name.
	const groups = new Map<string, string[]>();
	for (const p of md) {
		const key = noteName(p).toLowerCase();
		groups.set(key, [...(groups.get(key) ?? []), p]);
	}
	const taken = new Set(md.map((p) => noteName(p).toLowerCase()));
	const renames: { from: string; to: string }[] = [];
	const finalPath = new Map(md.map((p) => [p, p]));
	for (const paths of groups.values()) {
		if (paths.length < 2) continue;
		const sorted = [...paths].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
		for (const p of sorted.slice(1)) {
			const dir = dirOf(p);
			const parent = dir.split("/").pop() || "root";
			let name = parent.toLowerCase();
			if (taken.has(name)) name = `${parent}-${noteName(p)}`.toLowerCase();
			let n = 2;
			while (taken.has(name)) name = `${parent}-${noteName(p)}-${n++}`.toLowerCase();
			taken.add(name);
			const to = joinPath(dir, `${name}.md`);
			renames.push({ from: p, to });
			finalPath.set(p, to);
		}
	}
	const nameOf = (p: string) => noteName(finalPath.get(p) ?? p);
	const conventions = defaultConventions();
	conventions.notes.requiredFields = [];

	const issues: LinkIssue[] = [];
	const frontmatterFixed: string[] = [];
	const files: MigrationPlan["files"] = [];
	let total = 0;
	for (const path of md) {
		const text = texts.get(path) as string;
		const masked = maskCode(text);
		const starts = lineOffsets(text);
		let out = "";
		let last = 0;
		let converted = 0;
		MD_LINK.lastIndex = 0;
		for (let m = MD_LINK.exec(masked); m; m = MD_LINK.exec(masked)) {
			const [whole, bang, , rawTarget] = m as unknown as [string, string, string, string];
			const label = text.slice(m.index + bang.length + 1, m.index + bang.length + 1 + (m[2] as string).length);
			const line = lineAt(starts, m.index) + 1;
			const issue = (why: string) => issues.push({ file: path, line, link: whole, why });
			if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget) || rawTarget.startsWith("#") || rawTarget.startsWith("/")) continue;
			let target = rawTarget;
			try {
				target = decodeURIComponent(rawTarget);
			} catch {
				// keep as written
			}
			const hashAt = target.indexOf("#");
			const anchor = hashAt >= 0 ? target.slice(hashAt + 1) : null;
			const resolved = posix.normalize(posix.join(dirOf(path) || ".", hashAt >= 0 ? target.slice(0, hashAt) : target));
			if (resolved.startsWith("..") || !trackedSet.has(resolved)) {
				issue("target not found in the repo; left as is");
				continue;
			}
			const isNote = resolved.toLowerCase().endsWith(".md");
			const lineText = text.slice(starts[line - 1], starts[line] ?? text.length);
			const inTable = lineText.trimStart().startsWith("|");
			const sep = inTable ? "\\|" : "|";
			if (label.includes("]]") || (label.includes("|") && !inTable)) {
				issue("label contains ]] or |; left as is");
				continue;
			}
			let link: string;
			if (isNote) {
				const name = nameOf(resolved);
				let heading: string | null = null;
				if (anchor) {
					heading = headingsOf(texts.get(resolved) as string).find((h) => slugify(h) === anchor.toLowerCase()) ?? null;
					if (!heading) issue(`anchor #${anchor} matches no heading; linked to the note`);
				}
				const title = parseNote(texts.get(resolved) as string, conventions).meta.title;
				const plain = normalizeWords(label);
				const same = plain === normalizeWords(name) || (title !== null && plain === normalizeWords(title)) || (heading !== null && plain === normalizeWords(heading));
				link = `${bang}[[${name}${heading ? `#${heading}` : ""}${same || !label.trim() ? "" : `${sep}${label}`}]]`;
			} else {
				const file = resolved.split("/").pop() as string;
				link = bang ? `![[${file}]]` : `[[${file}${label.trim() ? `${sep}${label}` : ""}]]`;
			}
			out += text.slice(last, m.index) + link;
			last = m.index + whole.length;
			converted++;
		}
		let content = out + text.slice(last);
		const quoted = quoteFrontmatter(content);
		if (quoted !== null) {
			content = quoted;
			frontmatterFixed.push(path);
		}
		total += converted;
		files.push({ path, converted, content, changed: content !== text });
	}

	// What will resolve afterwards: every wikilink checked against the final names and files.
	const finalNames = new Set(md.map((p) => nameOf(p).toLowerCase()));
	const assetNames = new Set(tracked.filter((p) => !p.toLowerCase().endsWith(".md")).map((p) => (p.split("/").pop() as string).toLowerCase()));
	const broken: LinkIssue[] = [];
	for (const f of files) {
		for (const l of parseWikiLinks(f.content)) {
			if (l.targetName === nameOf(f.path).toLowerCase()) continue;
			if (!finalNames.has(l.targetName) && !assetNames.has(l.targetName)) broken.push({ file: f.path, line: l.line, link: f.content.slice(l.start, l.end), why: "does not resolve" });
		}
	}
	return { renames, frontmatterFixed, files, converted: total, issues, broken, notes: md.length };
}

/** Writes the plan and commits it in one commit. */
export async function applyMigration(repoDir: string, plan: MigrationPlan, opts: { conventions?: string | null; message?: string } = {}): Promise<string> {
	const git = new Git(repoDir);
	if (!(await git.isClean())) throw new Error("the repo has uncommitted changes; commit or stash them first");
	for (const f of plan.files) if (f.changed) await writeFile(join(repoDir, f.path), f.content, "utf8");
	for (const r of plan.renames) await git.run(["mv", r.from, r.to]);
	if (opts.conventions) await writeFile(join(repoDir, "memory.toml"), opts.conventions, "utf8");
	await git.run(["add", "-A"]);
	await git.run(["commit", "-q", "-F", "-"], {
		input: `${opts.message ?? "Migrate links to [[wikilinks]] with unique names"}\n\nTool: migrate\n`,
		env: { GIT_AUTHOR_NAME: "my-memory migration", GIT_AUTHOR_EMAIL: "migration@my-memory.invalid", GIT_COMMITTER_NAME: "my-memory migration", GIT_COMMITTER_EMAIL: "migration@my-memory.invalid" },
	});
	return (await git.head()) as string;
}

export function renderPlan(plan: MigrationPlan): string {
	const lines = [
		`Notes: ${plan.notes}`,
		`Links converted: ${plan.converted} in ${plan.files.filter((f) => f.changed).length} files`,
		`Frontmatter quoted to be valid YAML: ${plan.frontmatterFixed.length}${plan.frontmatterFixed.length ? ` (${plan.frontmatterFixed.join(", ")})` : ""}`,
		`Renames (name collisions): ${plan.renames.length ? plan.renames.map((r) => `${r.from} → ${r.to}`).join(", ") : "none"}`,
		`Links left as they were: ${plan.issues.length}`,
		...plan.issues.map((i) => `  ${i.file}:${i.line} ${i.link} — ${i.why}`),
		`Wikilinks that will not resolve: ${plan.broken.length}`,
		...plan.broken.map((i) => `  ${i.file}:${i.line} ${i.link}`),
	];
	return lines.join("\n");
}
