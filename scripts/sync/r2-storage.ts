/**
 * The site's R2 storage for the Overview, read by the figures step (never on a page load) from Cloudflare's GraphQL
 * analytics (`r2StorageAdaptiveGroups`), with ANALYTICS_API_TOKEN (Account Analytics: Read, as `views:sync`). Only
 * the stage's own buckets are asked for, by name (alchemy.run.ts): the account's other buckets are never read or
 * shown. Cloudflare measures each bucket every few minutes; the latest point within the last day counts.
 */
import { PREFIX, SPRITES_BUCKET, screenshotsBucket, type Stage } from '../../infra/databases';
import type { R2Bucket, R2Storage } from '#lib/sync.js';

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const WINDOW_MS = 24 * 3600 * 1000;

/** The stage's buckets, in the order the Overview lists them. */
export const siteBuckets = (stage: Stage): Pick<R2Bucket, 'kind' | 'name'>[] => [
	{ kind: 'renders', name: `${PREFIX}-${stage}-renders` },
	{ kind: 'screenshots', name: screenshotsBucket(stage) },
	{ kind: 'raw', name: `${PREFIX}-${stage}-raw` },
	{ kind: 'sprites', name: SPRITES_BUCKET }
];

export const R2_QUERY = `query R2Storage($account: string!, $since: Time!, $buckets: [string!]) {
	viewer {
		accounts(filter: { accountTag: $account }) {
			r2StorageAdaptiveGroups(limit: 2000, filter: { datetime_geq: $since, bucketName_in: $buckets }, orderBy: [datetime_DESC]) {
				max { objectCount payloadSize }
				dimensions { bucketName datetime }
			}
		}
	}
}`;

interface R2Row {
	max?: { objectCount?: number; payloadSize?: number };
	dimensions?: { bucketName?: string; datetime?: string };
}

/**
 * The GraphQL answer as each wanted bucket's latest objects and bytes. A bucket with no point in the window (empty,
 * or new) counts as 0; rows for any other bucket are ignored. Throws on GraphQL errors or an unexpected shape.
 */
export function parseR2Storage(body: unknown, wanted: Pick<R2Bucket, 'kind' | 'name'>[]): R2Bucket[] {
	const b = body as { errors?: { message?: string }[] | null; data?: { viewer?: { accounts?: { r2StorageAdaptiveGroups?: R2Row[] }[] } } };
	if (b?.errors?.length) throw new Error(b.errors.map((e) => e.message ?? 'error').join('; '));
	const rows = b?.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups;
	if (!Array.isArray(rows)) throw new Error('no r2StorageAdaptiveGroups in the answer');
	const latest = new Map<string, { at: string; objects: number; bytes: number }>();
	for (const r of rows) {
		const name = r.dimensions?.bucketName;
		const at = r.dimensions?.datetime ?? '';
		if (!name) continue;
		const seen = latest.get(name);
		if (seen && seen.at >= at) continue;
		latest.set(name, { at, objects: Number(r.max?.objectCount ?? 0), bytes: Number(r.max?.payloadSize ?? 0) });
	}
	return wanted.map((w) => ({ ...w, objects: latest.get(w.name)?.objects ?? 0, bytes: latest.get(w.name)?.bytes ?? 0 }));
}

/** The stage's R2 storage, or the reason there is none; never throws. */
export async function readR2Storage(o: {
	stage: Stage;
	account: () => string;
	token: string | undefined;
	now?: number;
	fetch?: typeof fetch;
}): Promise<R2Storage> {
	const at = o.now ?? Date.now();
	try {
		if (!o.token) throw new Error('ANALYTICS_API_TOKEN is not set');
		const wanted = siteBuckets(o.stage);
		const res = await (o.fetch ?? fetch)(GRAPHQL, {
			method: 'POST',
			headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				query: R2_QUERY,
				variables: { account: o.account(), since: new Date(at - WINDOW_MS).toISOString(), buckets: wanted.map((w) => w.name) }
			}),
			signal: AbortSignal.timeout(30_000)
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return { at, buckets: parseR2Storage(await res.json(), wanted) };
	} catch (e) {
		return { at, error: e instanceof Error ? e.message : String(e) };
	}
}
