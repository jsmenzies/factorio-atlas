import type { PageRef } from './viewer/types.js';

/** One book page in the page picker: its book path, its number in the book (1-based) and title. */
export interface GroupedPage {
	path: string;
	n: number;
	/** The page's title, less a stage number when the groups are stages. */
	title: string;
}

export interface PageGroup {
	/** "Stage 3", a sub-book's name, or null for a book with no groups. */
	title: string | null;
	/** The stage number, for "Stages 4–16" (null when the groups aren't stages). */
	stage: number | null;
	pages: GroupedPage[];
}

/** "3. Basic Smelting", "3) Basic Smelting", "3 - Basic Smelting" → stage 3, "Basic Smelting". */
const STAGE = /^\s*(\d{1,3})\s*[.):-]\s*(\S.*)$/;

/**
 * A book's blueprint pages in groups, in book order: by stage when most page names start with a
 * number (build-order books like Nilaus' Base-in-a-Book), else by the sub-book each page is in,
 * else one group with no title. Groups are runs of neighbouring pages, so a book that goes back to
 * an earlier stage gets a second group for it. `titleOf` gives any node's plain-text title.
 */
export const groupPages = (nodes: PageRef[], titleOf: (path: string) => string): PageGroup[] => {
	const pages = nodes.filter((n) => n.kind === 'blueprint').map((n, i) => ({ path: n.path, n: i + 1, title: titleOf(n.path) }));
	if (!pages.length) return [];

	const stages = pages.map((p) => STAGE.exec(p.title));
	const numbered = stages.filter(Boolean).length;
	if (numbered >= 2 && numbered >= pages.length * 0.6 && new Set(stages.map((m) => m?.[1])).size >= 2) {
		return runs(pages, (_, i) => {
			const m = stages[i];
			return m ? `stage:${Number(m[1])}` : 'other';
		}).map(([key, run]) => {
			const stage = key === 'other' ? null : Number(key.slice(6));
			return {
				title: stage === null ? 'Other pages' : `Stage ${stage}`,
				stage,
				pages: run.map(({ p, i }) => ({ ...p, title: stages[i]?.[2].trim() ?? p.title }))
			};
		});
	}

	const parent = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null);
	if (pages.some((p) => parent(p.path) !== null)) {
		const groups = runs(pages, (p) => parent(p.path) ?? '');
		// Each sub-book's chain of book names from the top, named by its shortest unique tail.
		const chains = groups.map(([key]) => {
			const chain: string[] = [];
			for (let at: string | null = key; at; at = parent(at)) chain.unshift(titleOf(at));
			return chain.length ? chain : ['Pages'];
		});
		const names = uniqueTails(chains);
		return groups.map(([, run], i) => ({
			title: chains[i].slice(-names[i].depth).join(' › ') + (names[i].number ? ` (${names[i].number})` : ''),
			stage: null,
			pages: run.map(({ p }) => p)
		}));
	}

	return [{ title: null, stage: null, pages }];
};

/**
 * How much of each chain names it: the shortest tail no other chain shares (`depth`), and a number
 * for chains still alike at full length (null when unique). `key` is what's compared.
 */
export const uniqueTails = (chains: string[][], key: (part: string) => string = (s) => s) => {
	const depth = chains.map(() => 1);
	const name = (i: number) => chains[i].slice(-depth[i]).map(key).join(' › ');
	for (let changed = true; changed;) {
		changed = false;
		const counts = new Map<string, number>();
		chains.forEach((_, i) => counts.set(name(i), (counts.get(name(i)) ?? 0) + 1));
		chains.forEach((chain, i) => {
			if (counts.get(name(i))! > 1 && depth[i] < chain.length) {
				depth[i]++;
				changed = true;
			}
		});
	}
	const totals = new Map<string, number>();
	chains.forEach((_, i) => totals.set(name(i), (totals.get(name(i)) ?? 0) + 1));
	const seen = new Map<string, number>();
	return chains.map((_, i) => {
		const n = (seen.get(name(i)) ?? 0) + 1;
		seen.set(name(i), n);
		return { depth: depth[i], number: totals.get(name(i))! > 1 ? n : null };
	});
};

/** Neighbouring items with the same key, with their indexes. */
const runs = <T>(items: T[], key: (item: T, i: number) => string) => {
	const out: [string, { p: T; i: number }[]][] = [];
	items.forEach((p, i) => {
		const k = key(p, i);
		const last = out.at(-1);
		if (last && last[0] === k) last[1].push({ p, i });
		else out.push([k, [{ p, i }]]);
	});
	return out;
};
