import type { Logger } from "./log.js";
import type { SearchIndex } from "./search-index.js";

/** `[embeddings]` of the config: an OpenAI-compatible `/v1/embeddings` endpoint (Ollama, llama.cpp, TEI, OpenAI…). */
export interface EmbeddingsConfig {
	/** Full URL of the endpoint, e.g. `http://127.0.0.1:11434/v1/embeddings`. */
	url: string;
	model: string;
	apiKey: string | null;
	/** Asked from models that can shorten their output (OpenAI `text-embedding-3-*`); null leaves it to the model. */
	dimensions: number | null;
	batchSize: number;
	timeoutSeconds: number;
	/** Some models want their inputs marked, e.g. nomic-embed-text: `search_query: ` / `search_document: `. */
	queryPrefix: string;
	documentPrefix: string;
}

/** Longer section texts are cut before embedding: small models only read the first few hundred tokens anyway. */
export const MAX_EMBED_CHARS = 4000;
/** A query waits at most this long for its vector before search falls back to text. */
const QUERY_TIMEOUT_MS = 5000;
/** After a failed query embedding, searches skip the endpoint for this long. */
const QUERY_COOLDOWN_MS = 30_000;

export class EmbeddingError extends Error {
	constructor(
		message: string,
		/** 4xx other than 429: the request itself is wrong, retrying it as is will not help. */
		readonly permanent = false,
	) {
		super(message);
	}
}

/** Unit length, so cosine similarity is a plain dot product. */
export function normalize(v: Float32Array): Float32Array {
	let sum = 0;
	for (const x of v) sum += x * x;
	const norm = Math.sqrt(sum);
	if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
	return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
	return s;
}

/** Reciprocal Rank Fusion: each list adds 1 / (k + rank) to the items it holds. */
export function reciprocalRankFusion<T>(lists: T[][], k = 60): Map<T, number> {
	const scores = new Map<T, number>();
	for (const list of lists) list.forEach((item, i) => scores.set(item, (scores.get(item) ?? 0) + 1 / (k + i + 1)));
	return scores;
}

/** Calls the embeddings endpoint. Never logs texts: they are note content or search queries. */
export class EmbeddingClient {
	constructor(readonly config: EmbeddingsConfig) {}

	/** What the stored vectors depend on besides the text: when it changes, every section is embedded again. */
	get key(): string {
		return JSON.stringify([this.config.model, this.config.dimensions, this.config.documentPrefix, MAX_EMBED_CHARS]);
	}

	async embed(texts: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Float32Array[]> {
		const signals = [AbortSignal.timeout(opts.timeoutMs ?? this.config.timeoutSeconds * 1000)];
		if (opts.signal) signals.push(opts.signal);
		let response: Response;
		try {
			response = await fetch(this.config.url, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
				body: JSON.stringify({ model: this.config.model, input: texts, ...(this.config.dimensions ? { dimensions: this.config.dimensions } : {}) }),
				signal: AbortSignal.any(signals),
			});
		} catch (error) {
			const cause = (error as { cause?: { code?: string } }).cause?.code;
			throw new EmbeddingError(`${(error as Error).name === "TimeoutError" ? "timed out" : (error as Error).message}${cause ? ` (${cause})` : ""}`);
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new EmbeddingError(`HTTP ${response.status}`, response.status >= 400 && response.status < 500 && response.status !== 429);
		}
		const body = (await response.json().catch(() => null)) as { data?: { embedding?: unknown; index?: number }[] } | null;
		const data = body?.data;
		if (!Array.isArray(data) || data.length !== texts.length) throw new EmbeddingError("unexpected response: wrong number of embeddings");
		const out: Float32Array[] = new Array(texts.length);
		data.forEach((d, i) => {
			if (!Array.isArray(d.embedding) || d.embedding.length === 0 || !d.embedding.every((x) => typeof x === "number")) throw new EmbeddingError("unexpected response: an embedding is not a list of numbers");
			out[typeof d.index === "number" ? d.index : i] = normalize(Float32Array.from(d.embedding as number[]));
		});
		if (out.some((v) => !v)) throw new EmbeddingError("unexpected response: bad indexes");
		return out;
	}
}

/**
 * Embeds the sections that have no vector yet, in the background. It never blocks a write: the index is updated
 * first, sections without a vector are simply found by text only, and a failing endpoint is retried with backoff.
 */
export class Embedder {
	private running: Promise<void> | null = null;
	private kick: NodeJS.Timeout | null = null;
	private retry: NodeJS.Timeout | null = null;
	private delay: number;
	private dirty = false;
	private stopped = false;
	private readonly abort = new AbortController();
	/** Texts the endpoint refuses one by one (too long for the model…): skipped until the process restarts. */
	private readonly refused = new Set<string>();
	private queryDownUntil = 0;

	constructor(
		readonly client: EmbeddingClient,
		private readonly index: () => SearchIndex,
		private readonly log: Logger,
		private readonly backoff: { initialMs: number; maxMs: number } = { initialMs: 30_000, maxMs: 600_000 },
	) {
		this.delay = backoff.initialMs;
	}

	/** Drops the stored vectors if they were made by another model or with other settings. */
	checkModel(): void {
		const index = this.index();
		if (index.getMeta("embeddings_key") === this.client.key) return;
		index.transaction(() => {
			index.clearVectors();
			index.setMeta("embeddings_key", this.client.key);
		});
	}

	status(): { model: string; vectors: number; pending: number } {
		return { model: this.client.config.model, vectors: this.index().vectorCount(), pending: this.index().pendingEmbeddingCount() };
	}

	/** Asks for a run soon. While a retry is waiting (endpoint down), the retry covers it. */
	schedule(): void {
		if (this.stopped) return;
		this.dirty = true;
		if (this.running || this.kick || this.retry) return;
		this.kick = setTimeout(() => {
			this.kick = null;
			this.start();
		}, 0);
		this.kick.unref();
	}

	/** Waits until no run is going on or about to start (a waiting retry does not count). */
	async idle(): Promise<void> {
		while (this.running || this.kick) await (this.running ?? new Promise((r) => setTimeout(r, 5)));
	}

	/** Runs now and waits for it; errors are thrown instead of retried (`my-memory reindex`). */
	async flush(): Promise<{ embedded: number; pending: number }> {
		await this.idle();
		if (this.retry) clearTimeout(this.retry);
		this.retry = null;
		let result = { embedded: 0, pending: 0 };
		const run = this.drain().then((r) => {
			result = r;
		});
		this.running = run.catch(() => undefined).finally(() => (this.running = null));
		await run;
		return result;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const t of [this.kick, this.retry]) if (t) clearTimeout(t);
		this.kick = this.retry = null;
		this.abort.abort();
		await this.running;
	}

	/** The query's vector, or null when the endpoint fails (the caller falls back to text). */
	async embedQuery(query: string): Promise<Float32Array | null> {
		if (Date.now() < this.queryDownUntil) return null;
		try {
			const [v] = await this.client.embed([`${this.client.config.queryPrefix}${query}`.slice(0, MAX_EMBED_CHARS)], { timeoutMs: Math.min(QUERY_TIMEOUT_MS, this.client.config.timeoutSeconds * 1000) });
			return v ?? null;
		} catch (error) {
			this.queryDownUntil = Date.now() + QUERY_COOLDOWN_MS;
			this.log("warn", "search.embedding_failed", { error: (error as Error).message, fallback: "text" });
			return null;
		}
	}

	private start(): void {
		const started = Date.now();
		this.running = this.drain()
			.then(({ embedded, pending }) => {
				this.delay = this.backoff.initialMs;
				if (embedded) this.log("info", "embeddings.done", { embedded, pending, ms: Date.now() - started });
			})
			.catch((error) => {
				if (this.stopped) return;
				let pending: number | null = null;
				try {
					pending = this.index().pendingEmbeddingCount();
				} catch {
					// the index may be closing
				}
				this.log("warn", "embeddings.failed", { error: (error as Error).message, pending, retry_in_ms: this.delay });
				this.retry = setTimeout(() => {
					this.retry = null;
					this.start();
				}, this.delay);
				this.retry.unref();
				this.delay = Math.min(this.delay * 2, this.backoff.maxMs);
			})
			.finally(() => {
				this.running = null;
				if (this.dirty && !this.retry && !this.stopped) this.schedule();
			});
	}

	/** Embeds batches until nothing is pending. Each batch is stored in its own short transaction. */
	private async drain(): Promise<{ embedded: number; pending: number }> {
		const { batchSize, documentPrefix } = this.client.config;
		let embedded = 0;
		for (;;) {
			this.dirty = false;
			if (this.stopped) throw new EmbeddingError("stopped");
			const batch = this.index()
				.pendingEmbeddings(batchSize + this.refused.size)
				.filter((p) => !this.refused.has(p.hash))
				.slice(0, batchSize);
			if (batch.length === 0) break;
			const texts = batch.map((p) => `${documentPrefix}${p.text}`.slice(0, MAX_EMBED_CHARS));
			let vectors: (Float32Array | null)[];
			try {
				vectors = await this.client.embed(texts, { signal: this.abort.signal });
			} catch (error) {
				if (!(error instanceof EmbeddingError && error.permanent)) throw error;
				// One bad text must not block the rest: try them one by one and set aside the ones refused.
				vectors = [];
				for (const text of texts) {
					vectors.push(
						await this.client.embed([text], { signal: this.abort.signal }).then(
							([v]) => v ?? null,
							(e) => {
								if (e instanceof EmbeddingError && e.permanent) return null;
								throw e;
							},
						),
					);
				}
				const refused = batch.filter((_, i) => !vectors[i]);
				for (const p of refused) this.refused.add(p.hash);
				if (refused.length) this.log("warn", "embeddings.refused", { sections: refused.length, error: (error as Error).message });
			}
			if (this.stopped) throw new EmbeddingError("stopped");
			const index = this.index();
			index.transaction(() => {
				batch.forEach((p, i) => {
					const v = vectors[i];
					if (v) index.putVector(p.hash, v);
				});
			});
			embedded += vectors.filter(Boolean).length;
		}
		const index = this.index();
		index.pruneVectors();
		return { embedded, pending: index.pendingEmbeddingCount() };
	}
}
