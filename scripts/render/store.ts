/**
 * Where `bun run render --upload` puts render files: a RENDERS bucket, behind one small interface so
 * the upload queue (upload.ts) doesn't care which.
 *
 * - `local`: the miniflare bucket `bun run dev` uses, through getPlatformProxy's binding.
 * - `prod`: the deployed bucket through R2's S3-compatible API
 *   (`https://<account id>.r2.cloudflarestorage.com/<bucket>/<key>`), signed with aws4fetch.
 *   Needs an R2 API token: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.
 *
 * Every call is retried with exponential backoff on network errors, timeouts, 408, 429 and 5xx.
 * 401 and 403 are fatal (wrong or missing permissions): retrying won't help.
 */
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AwsClient } from 'aws4fetch';

export interface RenderStore {
	/** For logs, e.g. `local RENDERS bucket`. */
	readonly label: string;
	put(key: string, body: Uint8Array, contentType: string, cacheControl: string, signal?: AbortSignal): Promise<void>;
	/** Deleting a key that isn't there is fine. */
	delete(key: string, signal?: AbortSignal): Promise<void>;
	/** Every key under `prefix`. */
	list(prefix: string, signal?: AbortSignal): Promise<string[]>;
}

export class StoreError extends Error {
	constructor(
		message: string,
		/** Worth another attempt: a network error, timeout, 408, 429 or 5xx. */
		readonly retryable: boolean,
		/** The store refuses us (401, 403): stop uploading. */
		readonly fatal = false,
		/** Server's Retry-After, in ms. */
		readonly retryAfterMs?: number
	) {
		super(message);
	}
}

export const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR');

export interface RetryOptions {
	attempts?: number;
	baseMs?: number;
	maxMs?: number;
	signal?: AbortSignal;
	onRetry?: (error: StoreError, attempt: number, waitMs: number) => void;
	/** For tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

/** Run `f` until it succeeds, retrying StoreErrors that say so: waits 0.5 s, 1 s, 2 s … up to 30 s, with jitter. */
export async function withRetries<T>(f: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
	const attempts = opts.attempts ?? 8;
	const base = opts.baseMs ?? 500;
	const max = opts.maxMs ?? 30_000;
	const wait = opts.sleep ?? ((ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }));
	for (let attempt = 1; ; attempt++) {
		opts.signal?.throwIfAborted();
		try {
			return await f();
		} catch (e) {
			if (isAbort(e) && opts.signal?.aborted) throw e;
			const err = e instanceof StoreError ? e : new StoreError(e instanceof Error ? e.message : String(e), true);
			if (!err.retryable || attempt >= attempts) throw err;
			const ms = Math.min(max, err.retryAfterMs ?? base * 2 ** (attempt - 1) * (0.75 + Math.random() / 2));
			opts.onRetry?.(err, attempt, ms);
			await wait(ms, opts.signal);
		}
	}
}

/** A signal that fires on `signal` or after `ms`. */
const within = (ms: number, signal?: AbortSignal) =>
	signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

/** Turn a failed fetch (thrown) into a StoreError; an abort from `signal` is passed through. */
const fetchError = (e: unknown, what: string, signal?: AbortSignal): unknown => {
	if (signal?.aborted) return e;
	const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'timed out' : e.message) : String(e);
	return new StoreError(`${what}: ${msg}`, true);
};

/** A StoreError for a non-2xx response. */
export async function responseError(res: Response, what: string): Promise<StoreError> {
	const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
	const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
	const retryAfter = Number(res.headers.get('retry-after'));
	const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
	const fatal = res.status === 401 || res.status === 403;
	const hint = fatal ? ' (check R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY and that the token has Object Read & Write on the bucket)' : '';
	return new StoreError(
		`${what}: HTTP ${res.status}${code ? ` ${code}` : ''}${text && !code ? ` ${text}` : ''}${hint}`,
		retryable,
		fatal,
		Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
	);
}

const unescapeXml = (s: string) =>
	s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, name: string, dec?: string, hex?: string) => {
		if (dec) return String.fromCodePoint(Number(dec));
		if (hex) return String.fromCodePoint(parseInt(hex, 16));
		return ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[name.toLowerCase()] ?? m;
	});

/** The parts of an S3 ListObjectsV2 response the uploader needs. */
export function parseListXml(xml: string): { keys: string[]; next: string | null } {
	const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => unescapeXml(m[1]));
	const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
	const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
	return { keys, next: truncated && token ? unescapeXml(token) : null };
}

/** Each path segment URL-encoded; `/` kept. */
export const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

const REQUEST_MS = 120_000;

export interface S3StoreOptions {
	accountId: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Defaults to `https://<account id>.r2.cloudflarestorage.com`. */
	endpoint?: string;
	fetch?: typeof fetch;
}

/** The deployed bucket through R2's S3 API. One attempt per call: wrap calls in withRetries. */
export function s3Store(opts: S3StoreOptions): RenderStore {
	const client = new AwsClient({
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
		service: 's3',
		region: 'auto',
		// Retries are ours (withRetries), so a request is signed afresh each time.
		retries: 0
	});
	const base = `${(opts.endpoint ?? `https://${opts.accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '')}/${encodeURIComponent(opts.bucket)}`;
	const doFetch = opts.fetch ?? fetch;
	const send = async (what: string, url: string, init: RequestInit, signal?: AbortSignal) => {
		const req = await client.sign(url, { ...init, signal: within(REQUEST_MS, signal) });
		try {
			return await doFetch(req);
		} catch (e) {
			throw fetchError(e, what, signal);
		}
	};
	return {
		label: `R2 bucket ${opts.bucket} (S3 API)`,
		async put(key, body, contentType, cacheControl, signal) {
			const what = `PUT ${key}`;
			const res = await send(
				what,
				`${base}/${encodeKey(key)}`,
				{
					method: 'PUT',
					body: body as Uint8Array<ArrayBuffer>,
					headers: {
						'content-type': contentType,
						'cache-control': cacheControl,
						// The real hash rather than UNSIGNED-PAYLOAD: R2 then rejects a body that arrives damaged.
						'x-amz-content-sha256': createHash('sha256').update(body).digest('hex')
					}
				},
				signal
			);
			if (!res.ok) throw await responseError(res, what);
			await res.body?.cancel();
		},
		async delete(key, signal) {
			const what = `DELETE ${key}`;
			const res = await send(what, `${base}/${encodeKey(key)}`, { method: 'DELETE' }, signal);
			if (!res.ok && res.status !== 404) throw await responseError(res, what);
			await res.body?.cancel();
		},
		async list(prefix, signal) {
			const keys: string[] = [];
			let token: string | null = null;
			do {
				const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
				if (token) q.set('continuation-token', token);
				const what = `LIST ${prefix}`;
				const res = await send(what, `${base}?${q}`, { method: 'GET' }, signal);
				if (!res.ok) throw await responseError(res, what);
				const page = parseListXml(await res.text());
				keys.push(...page.keys);
				token = page.next;
			} while (token);
			return keys;
		}
	};
}

/** A Workers R2 binding (the local miniflare bucket from getPlatformProxy). */
export function bindingStore(bucket: R2Bucket, label: string): RenderStore {
	const wrap = async <T>(what: string, f: () => Promise<T>, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		try {
			return await f();
		} catch (e) {
			throw fetchError(e, what, signal);
		}
	};
	return {
		label,
		put: (key, body, contentType, cacheControl, signal) =>
			wrap(`put ${key}`, () => bucket.put(key, body, { httpMetadata: { contentType, cacheControl } }).then(() => undefined), signal),
		delete: (key, signal) => wrap(`delete ${key}`, () => bucket.delete(key), signal),
		list: (prefix, signal) =>
			wrap(
				`list ${prefix}`,
				async () => {
					const keys: string[] = [];
					let cursor: string | undefined;
					do {
						const page = await bucket.list({ prefix, cursor, limit: 1000 });
						keys.push(...page.objects.map((o) => o.key));
						cursor = page.truncated ? page.cursor : undefined;
					} while (cursor);
					return keys;
				},
				signal
			)
	};
}
