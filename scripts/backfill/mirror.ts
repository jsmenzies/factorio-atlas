/**
 * The GitHub mirror of factorioprints (motlin/factorio-blueprint-firebase-cdn), read at one pinned
 * commit: one API call for the commit, one recursive tree call for every path, then each record from
 * raw.githubusercontent.com at that commit. Never Firebase, whose bandwidth is billed to
 * factorioprints.com's maintainer (data/README.md).
 *
 * Measured 2026-10-19 (≈3,000 requests, no 429/403 seen): raw.githubusercontent.com unauthenticated
 * 53/s at 16 in flight and 112/s at 32; with a `gh auth token` header ≈ 100/s. jsDelivr
 * (`cdn.jsdelivr.net/gh/…@<sha>/…`) is no real fallback: 7/s, and it answers 403 "Package size
 * exceeded the configured limit of 50 MB" or 404 for files it hasn't cached, since the repo is
 * 2.4 GB. It's still tried last, per file, after raw has been rate-limited three times.
 *
 * Every body is checked against the tree's git blob sha, so whatever served it, the bytes are the
 * pinned commit's.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { FACTORIOPRINTS_ID_PATTERN } from '#lib/print-id.js';
import { mirrorPath } from '#lib/server/pipeline/source.js';

export const MIRROR_REPO = 'motlin/factorio-blueprint-firebase-cdn';
const UA = 'factorio-atlas backfill';

export interface MirrorEntry {
	readonly id: string;
	readonly path: string;
	/** Bytes, from the tree. */
	readonly size: number;
	/** Git blob sha1. */
	readonly sha: string;
}

export class MirrorError extends Error {}

/** `gh auth token`, if gh is installed and logged in; never printed. */
export const ghToken = (): string | null => {
	try {
		const out = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		const token = out.status === 0 ? out.stdout.trim() : '';
		return token || null;
	} catch {
		return null;
	}
};

const api = async (path: string, token: string | null, accept = 'application/vnd.github+json', attempt = 0): Promise<Response> => {
	let res: Response;
	try {
		res = await fetch(`https://api.github.com/repos/${MIRROR_REPO}/${path}`, {
			headers: { accept, 'user-agent': UA, ...(token ? { authorization: `Bearer ${token}` } : {}) }
		});
	} catch (e) {
		if (attempt >= 4) throw new MirrorError(`GitHub API ${path}: ${e instanceof Error ? e.message : String(e)}`);
		await sleep(backoff(attempt));
		return api(path, token, accept, attempt + 1);
	}
	// Unauthenticated, the API allows 60 calls an hour; a run needs two. Retry with gh's token if that's used up.
	if ((res.status === 403 || res.status === 429) && !token) {
		const t = ghToken();
		if (t) return api(path, t, accept, attempt);
	}
	// The recursive tree call sometimes answers 500 while GitHub builds it; it succeeds on a retry.
	if (res.status >= 500 && attempt < 4) {
		await res.body?.cancel();
		await sleep(backoff(attempt));
		return api(path, token, accept, attempt + 1);
	}
	if (!res.ok) throw new MirrorError(`GitHub API ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	return res;
};

/** The mirror's current commit sha (default branch). */
export const resolveCommit = async () => (await (await api('commits/HEAD', null, 'application/vnd.github.sha')).text()).trim();

/** `<shard>/<factorioprints id>.json`. */
const ENTRY = new RegExp(`^[^/]+/(${FACTORIOPRINTS_ID_PATTERN})\\.json$`);

/** Every print at `sha`, in tree (path) order. One API call: the tree is ≈5.8 MB and 18k entries, under its 100k-entry limit. */
export const listMirror = async (sha: string): Promise<MirrorEntry[]> => {
	const tree = (await (await api(`git/trees/${sha}?recursive=1`, null)).json()) as {
		truncated: boolean;
		tree: { path: string; type: string; size?: number; sha: string }[];
	};
	if (tree.truncated) throw new MirrorError(`the tree at ${sha} is truncated; list it per directory instead`);
	const entries: MirrorEntry[] = [];
	for (const t of tree.tree) {
		const id = t.type === 'blob' ? ENTRY.exec(t.path)?.[1] : undefined;
		if (id && mirrorPath(id) === t.path) entries.push({ id, path: t.path, size: t.size ?? 0, sha: t.sha });
	}
	return entries;
};

export const rawUrl = (sha: string, path: string) => `https://raw.githubusercontent.com/${MIRROR_REPO}/${sha}/${path}`;
const jsdelivrUrl = (sha: string, path: string) => `https://cdn.jsdelivr.net/gh/${MIRROR_REPO}@${sha}/${path}`;

const gitBlobSha = (bytes: Uint8Array) => {
	const h = createHash('sha1');
	h.update(`blob ${bytes.byteLength}\0`);
	h.update(bytes);
	return h.digest('hex');
};

export type Via = 'raw' | 'raw+token' | 'jsdelivr';

const MAX_ATTEMPTS = 6;
const RATE_LIMITED_BEFORE_JSDELIVR = 3;

/** Fetches records at one commit, with backoff shared by every request in flight. */
export class MirrorFetcher {
	readonly stats = { raw: 0, 'raw+token': 0, jsdelivr: 0, retries: 0, rateLimited: 0, bytes: 0 };
	private token: string | null = null;
	private useToken = false;
	/** Every request waits until then after a 429/403. */
	private pausedUntil = 0;

	constructor(readonly sha: string) {}

	describe() {
		const s = this.stats;
		return (
			`raw ${s.raw}` +
			(s['raw+token'] ? ` · raw+token ${s['raw+token']}` : '') +
			(s.jsdelivr ? ` · jsDelivr ${s.jsdelivr}` : '') +
			(s.retries ? ` · retries ${s.retries}` : '') +
			(s.rateLimited ? ` · rate-limited ${s.rateLimited}` : '') +
			` · ${(s.bytes / 1e6).toFixed(1)} MB`
		);
	}

	async fetch(entry: MirrorEntry, signal?: AbortSignal): Promise<{ text: string; via: Via }> {
		let rateLimited = 0;
		let last = '';
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			if (attempt > 0) this.stats.retries++;
			const wait = this.pausedUntil - Date.now();
			if (wait > 0) await sleep(wait);
			signal?.throwIfAborted();
			const jsdelivr = rateLimited >= RATE_LIMITED_BEFORE_JSDELIVR;
			const via: Via = jsdelivr ? 'jsdelivr' : this.useToken ? 'raw+token' : 'raw';
			let res: Response;
			try {
				res = await fetch(jsdelivr ? jsdelivrUrl(this.sha, entry.path) : rawUrl(this.sha, entry.path), {
					signal,
					headers: { 'user-agent': UA, ...(via === 'raw+token' && this.token ? { authorization: `Bearer ${this.token}` } : {}) }
				});
			} catch (e) {
				signal?.throwIfAborted();
				last = `network: ${e instanceof Error ? e.message : String(e)}`;
				await sleep(backoff(attempt));
				continue;
			}
			if (res.ok) {
				const bytes = new Uint8Array(await res.arrayBuffer());
				if (gitBlobSha(bytes) === entry.sha) {
					this.stats[via]++;
					this.stats.bytes += bytes.byteLength;
					return { text: new TextDecoder().decode(bytes), via };
				}
				last = `${via} served content that doesn't match the tree's blob sha`;
				continue;
			}
			await res.body?.cancel();
			if (res.status === 404 && !jsdelivr) throw new MirrorError(`HTTP 404 at ${entry.path}`);
			if ((res.status === 429 || res.status === 403) && !jsdelivr) {
				this.stats.rateLimited++;
				rateLimited++;
				if (!this.useToken && this.token === null) this.token = ghToken();
				if (!this.useToken && this.token) {
					// Authenticated raw requests have their own, higher limit: switch every request over.
					this.useToken = true;
					continue;
				}
				const retryAfter = Number(res.headers.get('retry-after'));
				this.pausedUntil = Math.max(this.pausedUntil, Date.now() + (retryAfter > 0 ? retryAfter * 1000 : backoff(attempt)));
				last = `rate-limited (HTTP ${res.status})`;
				continue;
			}
			last = `HTTP ${res.status} from ${via}`;
			await sleep(backoff(attempt));
		}
		throw new MirrorError(last);
	}
}

/** 1 s, 2 s, 4 s … up to a minute. */
const backoff = (attempt: number) => Math.min(60_000, 1000 * 2 ** attempt);
