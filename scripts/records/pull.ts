/**
 * Filling the record store (store.ts) from a site, incrementally: the site's adapter lists every record
 * it has now with a revision, the store's index says which revision it holds, and only new and changed
 * records are fetched; records the site no longer lists leave the store. Pure apart from the store's
 * files; tested in pull.test.ts.
 */
import type { SourceRecord } from '#lib/server/pipeline/source-record.js';
import { dropRecord, putRecord, readIndex, writeIndex, type StoreIndex, type StoreSite } from './store';

/** One record as a site lists it: its id, and a revision that changes whenever the record does. */
export interface Listed {
	siteId: string;
	rev: string;
}

/**
 * A site that feeds the store. `list` gives every record the site has now (for uploads: the live ones);
 * `fetch` one record, or null when it has gone since the listing.
 */
export interface StoreAdapter {
	site: StoreSite;
	list(): Promise<Listed[]>;
	fetch(siteId: string): Promise<SourceRecord | null>;
}

export interface PullPlan {
	/** Listed now, and not in the store at that revision: new first, then changed. */
	fetch: Listed[];
	added: number;
	changed: number;
	/** In the store but no longer listed. */
	gone: string[];
	unchanged: number;
	listed: number;
}

export function planPull(listing: readonly Listed[], index: StoreIndex): PullPlan {
	const added: Listed[] = [];
	const changed: Listed[] = [];
	let unchanged = 0;
	const listed = new Set<string>();
	for (const l of listing) {
		if (listed.has(l.siteId)) continue;
		listed.add(l.siteId);
		const have = index.records[l.siteId];
		if (!have) added.push(l);
		else if (have.rev !== l.rev) changed.push(l);
		else unchanged++;
	}
	const gone = Object.keys(index.records)
		.filter((id) => !listed.has(id))
		.sort();
	return { fetch: [...added, ...changed], added: added.length, changed: changed.length, gone, unchanged, listed: listed.size };
}

export interface PullCounts {
	listed: number;
	/** New records written. */
	added: number;
	/** Changed records fetched (`rewritten` of them had new text). */
	changed: number;
	rewritten: number;
	removed: number;
	unchanged: number;
	/** Listed, but gone by the time it was fetched (removed from the store too). */
	vanished: number;
	/** Fetches that failed: left as they were, tried again next time. */
	failed: number;
	/** Not reached (stopped). */
	left: number;
}

export interface PullOptions {
	now?: () => number;
	stopping?: () => boolean;
	log?: (line: string) => void;
	/** Fetches in flight. */
	concurrency?: number;
	/** Plan only: no fetch, no write. */
	dryRun?: boolean;
}

/** Brings the store's records of `adapter.site` in line with what it lists. */
export async function pullSite(dir: string, adapter: StoreAdapter, o: PullOptions = {}): Promise<PullCounts> {
	const now = o.now ?? Date.now;
	const stopping = o.stopping ?? (() => false);
	const log = o.log ?? (() => undefined);
	const site = adapter.site;
	const index = await readIndex(dir, site);
	const plan = planPull(await adapter.list(), index);
	const counts: PullCounts = {
		listed: plan.listed,
		added: 0,
		changed: 0,
		rewritten: 0,
		removed: 0,
		unchanged: plan.unchanged,
		vanished: 0,
		failed: 0,
		left: 0
	};
	if (o.dryRun) {
		return { ...counts, added: plan.added, changed: plan.changed, removed: plan.gone.length, left: plan.fetch.length + plan.gone.length };
	}
	// Gone first: a record that left the site must never be rendered again.
	for (const siteId of plan.gone) {
		await dropRecord(dir, site, siteId);
		delete index.records[siteId];
		counts.removed++;
		log(`${site}/${siteId}: gone`);
	}
	if (plan.gone.length) await writeIndex(dir, site, index);

	const queue = [...plan.fetch];
	let sinceSave = 0;
	const one = async (l: Listed) => {
		let record: SourceRecord | null;
		try {
			record = await adapter.fetch(l.siteId);
			if (record && (record.site !== site || record.siteId !== l.siteId))
				throw new Error(`the record says it is ${record.site}/${record.siteId}`);
		} catch (e) {
			counts.failed++;
			log(`${site}/${l.siteId}: ✗ ${e instanceof Error ? e.message : e}`);
			return;
		}
		const had = index.records[l.siteId];
		if (!record) {
			await dropRecord(dir, site, l.siteId);
			delete index.records[l.siteId];
			counts.vanished++;
			return;
		}
		const wrote = await putRecord(dir, record);
		const t = now();
		index.records[l.siteId] = { rev: l.rev, firstSeen: had?.firstSeen ?? t, fetchedAt: t };
		if (had) {
			counts.changed++;
			if (wrote) counts.rewritten++;
		} else counts.added++;
		log(`${site}/${l.siteId}: ${had ? (wrote ? 'changed' : 'same text') : 'new'}`);
		if (++sinceSave >= 100) {
			sinceSave = 0;
			await writeIndex(dir, site, index);
		}
	};
	const workers = Array.from({ length: Math.max(1, o.concurrency ?? 6) }, async () => {
		while (queue.length && !stopping()) await one(queue.shift()!);
	});
	await Promise.all(workers);
	counts.left = queue.length;
	await writeIndex(dir, site, index);
	return counts;
}
