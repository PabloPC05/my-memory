// A stand-in for GitHub's REST and GraphQL APIs, backed by a real bare git repository: just the calls GitHubStore
// makes, answered with real git so commits, trees, fast-forward checks and conflicts behave like on GitHub.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Git } from "../src/git.js";
import { parseNameStatus } from "../src/util.js";

export interface FakeGitHub {
	url: string;
	/** Requests seen, as "METHOD /path" (without the query). */
	calls: string[];
	close: () => Promise<void>;
}

const STATUS: Record<string, string> = { A: "added", D: "removed", M: "modified", T: "changed", R: "renamed", C: "copied" };

export async function fakeGitHub(bare: string, owner = "alex", repo = "memoria", branch = "main"): Promise<FakeGitHub> {
	const git = new Git(bare);
	const calls: string[] = [];
	const base = `/repos/${owner}/${repo}`;

	const send = (res: ServerResponse, status: number, body: unknown, type = "application/json") => {
		const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
		res.writeHead(status, { "Content-Type": type, "Content-Length": data.length });
		res.end(data);
	};
	const readBody = (req: IncomingMessage) =>
		new Promise<unknown>((resolve) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null));
		});
	const resolve = async (rev: string) => {
		const r = await git.run(["rev-parse", "--verify", "-q", `${rev}^{commit}`], { allowFail: true });
		return r.code === 0 ? r.stdout.trim() : null;
	};
	const isAncestor = async (a: string, b: string) => (await git.run(["merge-base", "--is-ancestor", a, b], { allowFail: true })).code === 0;
	const restCommit = async (sha: string, withFiles: boolean) => {
		const raw = await git.out(["show", "-s", "--format=%P%x1f%an%x1f%ae%x1f%aI%x1f%B", sha]);
		const [parents, name, email, date, message] = raw.split("\x1f") as string[];
		const out: Record<string, unknown> = {
			sha,
			parents: (parents ?? "").trim().split(" ").filter(Boolean).map((p) => ({ sha: p })),
			commit: { message: (message ?? "").replace(/\n+$/, ""), author: { name, email, date } },
		};
		if (withFiles) {
			const parent = (parents ?? "").trim().split(" ")[0];
			const changes = parent ? parseNameStatus(await git.out(["diff", "-M", "--name-status", parent, sha])) : (await git.out(["ls-tree", "-r", "--name-only", sha])).trim().split("\n").filter(Boolean).map((p) => ({ status: "A", path: p }));
			out.files = changes.map((c) => ({ filename: c.path, status: STATUS[c.status] ?? "modified", ...(c.from ? { previous_filename: c.from } : {}) }));
		}
		return out;
	};

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = decodeURIComponent(url.pathname);
		const method = req.method ?? "GET";
		calls.push(`${method} ${path}`);
		if (!(req.headers.authorization ?? "").startsWith("Bearer ")) return send(res, 401, { message: "Requires authentication" });

		if (method === "POST" && path === "/graphql") {
			const body = (await readBody(req)) as { query: string; variables: { expr: string } };
			const object: Record<string, unknown> = {};
			for (const m of body.query.matchAll(/(f\d+): history\(first: 1, path: ("(?:[^"\\]|\\.)*")\)/g)) {
				const p = JSON.parse(m[2] as string) as string;
				const line = (await git.out(["log", "-1", "--format=%aI%x1f%an", body.variables.expr, "--", p])).trim();
				const [authoredDate, name] = line.split("\x1f");
				object[m[1] as string] = { nodes: line ? [{ authoredDate, author: { name } }] : [] };
			}
			return send(res, 200, { data: { repository: { object } } });
		}
		if (!path.startsWith(`${base}/`)) return send(res, 404, { message: "Not Found" });
		const rest = path.slice(base.length);
		let m: RegExpExecArray | null;

		if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
			const sha = await resolve(`refs/heads/${m[1]}`);
			return sha ? send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }) : send(res, 404, { message: "Not Found" });
		}
		if (method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
			const body = (await readBody(req)) as { sha: string; force?: boolean };
			const current = await resolve(`refs/heads/${m[1]}`);
			if (current && !body.force && !(await isAncestor(current, body.sha))) return send(res, 422, { message: "Update is not a fast forward" });
			await git.run(["update-ref", `refs/heads/${m[1]}`, body.sha]);
			return send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha: body.sha } });
		}
		if (method === "GET" && (m = /^\/tarball\/(.+)$/.exec(rest))) {
			const sha = await resolve(m[1] as string);
			if (!sha) return send(res, 404, { message: "Not Found" });
			const tgz = gzipSync(await git.bytes(["archive", "--format=tar", `--prefix=${owner}-${repo}-${sha.slice(0, 7)}/`, sha]));
			return send(res, 200, tgz, "application/x-gzip");
		}
		if (method === "GET" && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
			const raw = await git.run(["cat-file", "-p", m[1] as string], { allowFail: true });
			if (raw.code !== 0) return send(res, 404, { message: "Not Found" });
			const [head = "", ...msg] = raw.stdout.split("\n\n");
			const tree = /^tree (\w+)/m.exec(head)?.[1];
			const parents = [...head.matchAll(/^parent (\w+)/gm)].map((p) => ({ sha: p[1] }));
			return send(res, 200, { sha: m[1], tree: { sha: tree }, parents, message: msg.join("\n\n").replace(/\n+$/, "") });
		}
		if (method === "GET" && (m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
			const out = await git.out(["ls-tree", "-r", "-z", m[1] as string]);
			const tree = out
				.split("\0")
				.filter(Boolean)
				.map((line) => {
					const [meta, p] = line.split("\t") as [string, string];
					const [mode, type, sha] = meta.split(" ");
					return { path: p, mode, type, sha };
				});
			return send(res, 200, { sha: m[1], tree, truncated: false });
		}
		if (method === "POST" && rest === "/git/blobs") {
			const body = (await readBody(req)) as { content: string; encoding: string };
			const data = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
			const sha = (await git.run(["hash-object", "-w", "--stdin"], { input: data })).stdout.trim();
			return send(res, 201, { sha });
		}
		if (method === "GET" && (m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))) {
			const data = await git.bytes(["cat-file", "blob", m[1] as string]);
			return send(res, 200, { sha: m[1], content: data.toString("base64"), encoding: "base64" });
		}
		if (method === "POST" && rest === "/git/trees") {
			const body = (await readBody(req)) as { base_tree?: string; tree: { path: string; mode: string; sha: string | null }[] };
			const dir = await mkdtemp(join(tmpdir(), "fake-gh-index-"));
			const env = { GIT_INDEX_FILE: join(dir, "index") };
			try {
				await git.run(body.base_tree ? ["read-tree", body.base_tree] : ["read-tree", "--empty"], { env });
				for (const e of body.tree) {
					if (e.sha === null) await git.run(["update-index", "--index-info"], { env, input: `0 ${"0".repeat(40)}	${e.path}
` });
					else await git.run(["update-index", "--add", "--cacheinfo", `${e.mode},${e.sha},${e.path}`], { env });
				}
				const sha = (await git.run(["write-tree"], { env })).stdout.trim();
				return send(res, 201, { sha });
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}
		if (method === "POST" && rest === "/git/commits") {
			const body = (await readBody(req)) as { message: string; tree: string; parents: string[]; author: { name: string; email: string; date: string } };
			const env = { GIT_AUTHOR_NAME: body.author.name, GIT_AUTHOR_EMAIL: body.author.email, GIT_AUTHOR_DATE: body.author.date, GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" };
			const args = ["commit-tree", body.tree, ...body.parents.flatMap((p) => ["-p", p]), "-F", "-"];
			const sha = (await git.run(args, { input: body.message, env })).stdout.trim();
			return send(res, 201, { sha });
		}
		if (method === "GET" && (m = /^\/compare\/([^.]+)\.\.\.(.+)$/.exec(rest))) {
			const [a, b] = [await resolve(m[1] as string), await resolve(m[2] as string)];
			if (!a || !b) return send(res, 404, { message: "Not Found" });
			const status = a === b ? "identical" : (await isAncestor(a, b)) ? "ahead" : (await isAncestor(b, a)) ? "behind" : "diverged";
			const mergeBase = (await git.out(["merge-base", a, b])).trim();
			const shas = (await git.out(["rev-list", "--reverse", `${mergeBase}..${b}`])).trim().split("\n").filter(Boolean);
			const commits = await Promise.all(shas.map((s) => restCommit(s, false)));
			const files = parseNameStatus(await git.out(["diff", "-M", "--name-status", mergeBase, b])).map((c) => ({ filename: c.path, status: STATUS[c.status] ?? "modified", ...(c.from ? { previous_filename: c.from } : {}) }));
			return send(res, 200, { status, ahead_by: shas.length, commits, files });
		}
		if (method === "GET" && rest === "/commits") {
			const sha = url.searchParams.get("sha") ?? branch;
			const perPage = Number(url.searchParams.get("per_page") ?? 30);
			const page = Number(url.searchParams.get("page") ?? 1);
			const since = url.searchParams.get("since");
			const p = url.searchParams.get("path");
			const out = await git.out(["log", "--format=%H", `--skip=${(page - 1) * perPage}`, `-n${perPage}`, ...(since ? [`--since=${since}`] : []), sha, ...(p ? ["--", p] : [])]);
			const list = await Promise.all(out.trim().split("\n").filter(Boolean).map((s) => restCommit(s, false)));
			return send(res, 200, list);
		}
		if (method === "GET" && (m = /^\/commits\/(.+)$/.exec(rest))) {
			const sha = await resolve(m[1] as string);
			return sha ? send(res, 200, await restCommit(sha, true)) : send(res, 422, { message: "No commit found" });
		}
		if (method === "GET" && (m = /^\/contents\/(.+)$/.exec(rest))) {
			const ref = url.searchParams.get("ref") ?? branch;
			const r = await git.run(["cat-file", "-e", `${ref}:${m[1]}`], { allowFail: true });
			if (r.code !== 0) return send(res, 404, { message: "Not Found" });
			return send(res, 200, await git.bytes(["show", `${ref}:${m[1]}`]), "application/octet-stream");
		}
		return send(res, 404, { message: `Not Found (fake): ${method} ${rest}` });
	};

	const server: Server = createServer((req, res) => {
		handle(req, res).catch((error) => send(res, 500, { message: String(error) }));
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const port = (server.address() as { port: number }).port;
	return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((ok) => server.close(() => ok())) };
}
