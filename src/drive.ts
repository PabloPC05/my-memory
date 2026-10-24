/**
 * Google Drive access for the files side of a memory: an OAuth client with a refresh token (the user's own Drive).
 * Scopes it needs: `drive.readonly` to index and read the files (or `drive` if something should write there), and
 * `drive.appdata` to keep the index snapshot in the app's hidden folder (optional: without it, a cold start lists
 * the whole Drive again).
 */
export interface DriveConfig {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	/** API base, for tests. Default https://www.googleapis.com. */
	apiUrl?: string;
	/** Token endpoint, for tests. Default https://oauth2.googleapis.com/token. */
	tokenUrl?: string;
}

export class DriveError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "DriveError";
	}
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class DriveClient {
	readonly apiUrl: string;
	private access: { token: string; expires: number } | null = null;
	private pending: Promise<string> | null = null;

	constructor(private readonly config: DriveConfig) {
		this.apiUrl = (config.apiUrl ?? "https://www.googleapis.com").replace(/\/+$/, "");
	}

	private async token(): Promise<string> {
		if (this.access && Date.now() < this.access.expires - 60_000) return this.access.token;
		this.pending ??= (async () => {
			const r = await fetch(this.config.tokenUrl ?? "https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: this.config.refreshToken, grant_type: "refresh_token" }),
				signal: AbortSignal.timeout(15_000),
			});
			const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
			if (!r.ok || !j.access_token) throw new DriveError(r.status, `Google refused the Drive token: ${j.error_description ?? j.error ?? r.status}`);
			this.access = { token: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 };
			return j.access_token;
		})().finally(() => {
			this.pending = null;
		});
		return this.pending;
	}

	/** One request with the token; renews it once on a 401. Never throws on an HTTP status. */
	async request(method: string, path: string, opts: { query?: Query; body?: Buffer | string; contentType?: string } = {}): Promise<Response> {
		const url = new URL(path.startsWith("http") ? path : `${this.apiUrl}${path}`);
		for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
		for (let attempt = 0; ; attempt++) {
			const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
			if (opts.contentType) headers["Content-Type"] = opts.contentType;
			let r: Response;
			try {
				r = await fetch(url, { method, headers, body: opts.body as Uint8Array | string | undefined, signal: AbortSignal.timeout(60_000) });
			} catch (error) {
				if (attempt === 0) continue;
				throw new DriveError(0, `Google Drive is unreachable: ${(error as Error).message}${(error as { cause?: Error }).cause ? ` (${(error as { cause: Error }).cause.message})` : ""}`);
			}
			if (r.status === 401 && attempt === 0) {
				this.access = null;
				continue;
			}
			if (r.status >= 500 && attempt === 0) continue;
			return r;
		}
	}

	async json<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
		const r = await this.request(method, path, { query: opts.query, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body), contentType: "application/json" } : {}) });
		if (!r.ok) throw new DriveError(r.status, `Google Drive ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
		return (await r.json()) as T;
	}

	/** Raw bytes; null on 404. */
	async bytes(path: string, query: Query = {}): Promise<Buffer | null> {
		const r = await this.request("GET", path, { query });
		if (r.status === 404) return null;
		if (!r.ok) throw new DriveError(r.status, `Google Drive GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
		return Buffer.from(await r.arrayBuffer());
	}
}
