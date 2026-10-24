/** Where a memory's notes live on GitHub, and the token that can read and write them. */
export interface GitHubRepoConfig {
	owner: string;
	repo: string;
	branch: string;
	/** A fine-grained token with Contents read and write on this repository (or a classic one with `repo`). */
	token: string;
	/** REST API base, for GitHub Enterprise or tests. Default https://api.github.com. */
	apiUrl?: string;
	/** GraphQL endpoint. Default `<apiUrl>/graphql`. */
	graphqlUrl?: string;
}

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly body: unknown = null,
	) {
		super(message);
		this.name = "GitHubError";
	}
}

type RequestOptions = { body?: unknown; accept?: string; query?: Record<string, string | number | undefined | null> };

/** A thin client for the few GitHub REST and GraphQL calls a memory needs. No dependencies: the built-in fetch. */
export class GitHubClient {
	readonly apiUrl: string;
	readonly graphqlUrl: string;

	constructor(readonly config: GitHubRepoConfig) {
		this.apiUrl = (config.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
		this.graphqlUrl = config.graphqlUrl ?? `${this.apiUrl}/graphql`;
	}

	/** `/repos/<owner>/<repo>` plus a path. */
	repoPath(path: string): string {
		return `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}${path}`;
	}

	private headers(accept: string, json: boolean): Record<string, string> {
		return {
			Accept: accept,
			Authorization: `Bearer ${this.config.token}`,
			"User-Agent": "my-memory",
			"X-GitHub-Api-Version": "2022-11-28",
			...(json ? { "Content-Type": "application/json" } : {}),
		};
	}

	/** One request; retries once on a 5xx or a network error. Never throws on an HTTP status. */
	async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
		const url = new URL(path.startsWith("http") ? path : `${this.apiUrl}${path}`);
		for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
		const init: RequestInit = { method, headers: this.headers(opts.accept ?? "application/vnd.github+json", opts.body !== undefined), signal: AbortSignal.timeout(30_000) };
		if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
		for (let attempt = 0; ; attempt++) {
			try {
				const r = await fetch(url, init);
				if (r.status >= 500 && attempt === 0) continue;
				return r;
			} catch (error) {
				if (attempt === 0) continue;
				throw new GitHubError(0, `GitHub is unreachable: ${(error as Error).message}`);
			}
		}
	}

	private async fail(r: Response, what: string): Promise<never> {
		const text = await r.text().catch(() => "");
		let body: unknown = text;
		try {
			body = JSON.parse(text);
		} catch {}
		const message = (body as { message?: string } | null)?.message ?? text.slice(0, 200);
		throw new GitHubError(r.status, `GitHub ${what}: ${r.status} ${message}`.trim(), body);
	}

	async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
		const r = await this.request(method, path, opts);
		if (!r.ok) return this.fail(r, `${method} ${path.split("?")[0]}`);
		return (await r.json()) as T;
	}

	/** Like `json`, but null on 404 (and on 409, which is what an empty repository answers). */
	async optionalJson<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T | null> {
		const r = await this.request(method, path, opts);
		if (r.status === 404 || r.status === 409) return null;
		if (!r.ok) return this.fail(r, `${method} ${path.split("?")[0]}`);
		return (await r.json()) as T;
	}

	/** Raw bytes (a tarball, a file's raw content); null on 404. */
	async bytes(path: string, opts: RequestOptions = {}): Promise<Buffer | null> {
		const r = await this.request("GET", path, opts);
		if (r.status === 404) return null;
		if (!r.ok) return this.fail(r, `GET ${path.split("?")[0]}`);
		return Buffer.from(await r.arrayBuffer());
	}

	async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
		const r = await this.request("POST", this.graphqlUrl, { body: { query, variables } });
		if (!r.ok) return this.fail(r, "GraphQL");
		const out = (await r.json()) as { data?: T; errors?: { message: string }[] };
		if (out.errors?.length) throw new GitHubError(200, `GitHub GraphQL: ${out.errors.map((e) => e.message).join("; ")}`, out.errors);
		return out.data as T;
	}
}
