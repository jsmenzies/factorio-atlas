/**
 * Content fingerprints: what makes two prints, on any site, the same print. Pure.
 *
 * Each blueprint page gets two hashes:
 * - `exact`: the page's entities, tiles, wires and schedules, without what changes on a re-export or
 *   an edit of its words: entity numbers (wires refer to sorted positions instead), the place in the
 *   world (entities and tiles moved together, so the smallest x and y over both are 0: entities shifted
 *   on their floor are another print), entity order, `version`, label, description, icons.
 * - `layout`: names (renamed to today's), positions, directions (1.x's 8 counted as 2.0's 16), recipes,
 *   underground ends and wires only, so a print saved again in a newer game version still matches.
 *   Entities and tiles are each measured from their own smallest x and y: 0.15–0.18 saved entity
 *   positions half a tile off (`alignToGrid` in extract.ts) but tiles on whole tiles, so one origin
 *   would part an old save from the same print saved again in a newer version.
 * A book also gets the hash of its pages' hashes in order, and of the same set sorted.
 * Pages with neither entities nor tiles get none.
 *
 * The whole print's identity (`whole`), what joins and folds prints (admit.ts, fold.ts): its one
 * page's hashes when it has one (a lone blueprint and a book holding only it are the same print), else
 * the book's pages in order. The same pages in another order are another print (user, 2026-10-30): the
 * set hashes only help suggest.
 *
 * The hashes are stored (`print_fingerprints`, migration 0022) and blocked (`removal_blocks` 'sha256'):
 * changing what goes into them needs a migration that empties print_fingerprints and an INDEX_VERSION
 * bump to fill it again, and leaves existing hash blocks behind.
 */
import { bookEntryIndex, decodeGameVersion } from './decode.js';
import { gameData } from './game-data.js';

/**
 * Version of what the ingest writes to the identity tables (fingerprints, sources, folds). In the one-click
 * update's skip key (scripts/sync.ts), so the first update after it changes runs the backfill, which fills
 * what is missing. Bump it with any change to the hashes (see the header) or to what fills the tables.
 * 1: print_sources, print_fingerprints and the soft fold (migration 0022).
 */
export const IDENTITY_VERSION = 1;

type Json = Record<string, unknown>;

export interface PageFingerprint {
	/**
	 * Book path: "" for a lone blueprint, else "3", "3/1", …: the same as the analysis' `nodes[].path` and
	 * the viewer's, a missing `index` counting as the entry's position (bookEntryIndex); paths repeat only
	 * where a book repeats an `index`, as they do there.
	 */
	readonly path: string;
	readonly label: string | null;
	readonly entities: number;
	readonly tiles: number;
	readonly exact: string;
	readonly layout: string;
}

export interface BookFingerprint {
	readonly exact: string;
	readonly layout: string;
	/** Of the page hashes sorted: the same pages in another order. */
	readonly exactSet: string;
	readonly layoutSet: string;
}

/** What two prints must share to be the same print. `size` is entities + tiles over every page. */
export interface PrintKey {
	readonly exact: string;
	readonly layout: string;
	readonly size: number;
}

export interface PrintFingerprint {
	readonly pages: readonly PageFingerprint[];
	/** Null when no page has entities or tiles (planners, empty books). */
	readonly whole: PrintKey | null;
	/** Null unless the print is a book with at least one fingerprinted page. */
	readonly book: BookFingerprint | null;
}

const sha256 = async (text: string) => {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const KINDS = ['blueprint', 'blueprint_book', 'upgrade_planner', 'deconstruction_planner'] as const;
const MAX_DEPTH = 32;

interface RawPage {
	path: string;
	body: Json;
	version: [number, number, number, number] | null;
}

/** Walks a payload as analyze.ts and extract.ts do (`walkNodes`), so paths and versions agree with theirs. */
function* walk(obj: unknown, path: number[], inherited: RawPage['version']): Generator<RawPage> {
	if (path.length > MAX_DEPTH || !obj || typeof obj !== 'object') return;
	const kind = KINDS.find((k) => k in (obj as Json));
	if (!kind) return;
	const body = ((obj as Json)[kind] ?? {}) as Json;
	const version = decodeGameVersion(body.version) ?? inherited;
	if (kind === 'blueprint') yield { path: path.join('/'), body, version };
	else if (kind === 'blueprint_book') {
		const entries = Array.isArray(body.blueprints) ? (body.blueprints as Json[]) : [];
		for (const [i, child] of entries.entries()) yield* walk(child, [...path, bookEntryIndex(child, i)], version);
	}
}

/** JSON with object keys sorted, so equal values give equal text. */
const stable = (v: unknown): string => {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) {
		// The same text as element by element, but native: the big lists (rows, tiles, wires) are strings.
		if (v.every((x) => typeof x === 'string')) return JSON.stringify(v);
		return `[${v.map(stable).join(',')}]`;
	}
	const o = v as Json;
	let out = '';
	for (const k of Object.keys(o).sort()) {
		if (o[k] === undefined) continue;
		out += `${out ? ',' : ''}${quoteKey(k)}:${stable(o[k])}`;
	}
	return `{${out}}`;
};

const keys = new Map<string, string>();
/** JSON.stringify of an object key, remembered: entities repeat the same few dozen keys. */
const quoteKey = (k: string) => {
	let q = keys.get(k);
	if (q === undefined) {
		q = JSON.stringify(k);
		if (keys.size < 10_000) keys.set(k, q);
	}
	return q;
};

/**
 * `xs` sorted by `key` then `tie` as `<` compares strings, ties left in their order: the same order as
 * `sort((a, b) => cmp(key(a), key(b)) || cmp(tie(a), tie(b)))`, but by the native string sort. "\0" can't
 * appear in either (JSON text escapes it) and sorts before every other character, so it separates them
 * without changing the order; the zero-padded index keeps equal keys in their order.
 */
const sortedBy = <T>(xs: readonly T[], key: (x: T) => string, tie: (x: T) => string = () => ''): T[] => {
	const width = String(xs.length).length;
	const keyed = xs.map((x, i) => `${key(x)}\0${tie(x)}\0${String(i).padStart(width, '0')}`);
	return keyed.sort().map((k) => xs[Number(k.slice(k.lastIndexOf('\0') + 1))]);
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
/** Positions to 1/256 of a tile, so float noise never splits a match. */
const q = (v: number) => Math.round(v * 256) / 256;
const direction = (d: unknown, major: number) => {
	const n = Math.round(num(d));
	return (((major < 2 ? n * 2 : n) % 16) + 16) % 16;
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A wire end: [entity, connector]. 2.0 connectors: 1/3 red, 2/4 green (circuit 1/2), 5+ copper. */
type End = [number, number];

/**
 * Every wire as [a, connector, b, connector] in 2.0's form, whichever version saved it: 1.x keeps
 * circuit wires on both ends (`connections` by circuit id, then colour) and pole copper in
 * `neighbours`; a power switch's copper is `Cu0`/`Cu1`.
 */
const wiresOf = (body: Json, entities: Json[]): [End, End][] => {
	const out: [End, End][] = [];
	if (Array.isArray(body.wires)) {
		for (const w of body.wires as unknown[]) {
			if (Array.isArray(w) && w.length >= 4)
				out.push([
					[num(w[0]), num(w[1])],
					[num(w[2]), num(w[3])]
				]);
		}
	}
	for (const e of entities) {
		const n = num(e.entity_number);
		const conns = e.connections;
		if (conns && typeof conns === 'object') {
			for (const [point, c] of Object.entries(conns as Json)) {
				if (point === 'Cu0' || point === 'Cu1') {
					for (const t of Array.isArray(c) ? (c as Json[]) : [])
						out.push([
							[n, point === 'Cu0' ? 5 : 6],
							[num(t.entity_id), 5]
						]);
					continue;
				}
				const circuit = point === '2' ? 2 : 1;
				for (const [colour, offset] of [
					['red', 1],
					['green', 2]
				] as const) {
					const list = c && typeof c === 'object' ? (c as Json)[colour] : undefined;
					for (const t of Array.isArray(list) ? (list as Json[]) : []) {
						const other = typeof t.circuit_id === 'number' ? t.circuit_id : 1;
						out.push([
							[n, offset + (circuit - 1) * 2],
							[num(t.entity_id), offset + (other - 1) * 2]
						]);
					}
				}
			}
		}
		if (Array.isArray(e.neighbours))
			for (const t of e.neighbours)
				out.push([
					[n, 5],
					[num(t), 5]
				]);
	}
	return out;
};

/** Wires renumbered by the entities' sorted order, each end pair and the list sorted, both-end duplicates dropped. */
const canonicalWires = (wires: [End, End][], renumber: Map<number, number>) => {
	const seen = new Set<string>();
	for (const [a, b] of wires) {
		const ea: End = [renumber.get(a[0]) ?? -1, a[1]];
		const eb: End = [renumber.get(b[0]) ?? -1, b[1]];
		const [x, y] = ea[0] < eb[0] || (ea[0] === eb[0] && ea[1] <= eb[1]) ? [ea, eb] : [eb, ea];
		seen.add(`${x[0]}.${x[1]}-${y[0]}.${y[1]}`);
	}
	return [...seen].sort();
};

const SKIP_EXACT = new Set(['entity_number', 'position', 'connections', 'neighbours']);

async function pageFingerprint(page: RawPage): Promise<PageFingerprint | null> {
	const entities = (Array.isArray(page.body.entities) ? page.body.entities : []).filter((e): e is Json => !!e && typeof e === 'object');
	const tiles = (Array.isArray(page.body.tiles) ? page.body.tiles : []).filter((t): t is Json => !!t && typeof t === 'object');
	if (entities.length === 0 && tiles.length === 0) return null;
	const major = page.version?.[0] ?? 2;
	const saved: [number, number] = page.version ? [page.version[0], page.version[1]] : [2, 0];
	const pos = (o: Json) => {
		const p = (o.position ?? {}) as Json;
		return [num(p.x), num(p.y)] as const;
	};
	const minOf = (list: Json[]) => {
		let x = Infinity;
		let y = Infinity;
		for (const o of list) {
			const [px, py] = pos(o);
			x = Math.min(x, px);
			y = Math.min(y, py);
		}
		return [x, y] as const;
	};
	// Layout: entities and tiles each from their own corner; exact: both from one (see the header).
	const [ex, ey] = minOf(entities);
	const [tx, ty] = minOf(tiles);
	const ox = Math.min(ex, tx);
	const oy = Math.min(ey, ty);

	// Sorted by what the layout keeps; ties (rare: stacked entities) by the rest of the entity.
	const rows = entities.map((e) => {
		const [x, y] = pos(e);
		const rest: Json = {};
		for (const k of Object.keys(e)) if (!SKIP_EXACT.has(k)) rest[k] = e[k];
		const name = str(e.name) ?? '';
		const recipe = str(e.recipe);
		const type = str(e.type);
		const layout = stable([
			gameData.migrate('entity', name, saved),
			q(x - ex),
			q(y - ey),
			direction(e.direction, major),
			recipe ? gameData.migrate('recipe', recipe, saved) : null,
			type === 'input' || type === 'output' ? type : null
		]);
		const exact = stable({ ...rest, x: q(x - ox), y: q(y - oy) });
		return { n: num(e.entity_number), layout, exact };
	});
	const renumberBy = (key: 'layout' | 'exact') => {
		const order = sortedBy(
			rows,
			(r) => r[key],
			(r) => r.exact
		);
		return { order, map: new Map(order.map((r, i) => [r.n, i])) };
	};
	const wires = wiresOf(page.body, entities);
	const tileRows = (layout: boolean) =>
		tiles
			.map((t) => {
				const [x, y] = pos(t);
				const name = str(t.name) ?? '';
				return layout ? stable([gameData.migrate('tile', name, saved), q(x - tx), q(y - ty)]) : stable([name, q(x - ox), q(y - oy)]);
			})
			// The native sort compares as `cmp` does (UTF-16 code units).
			.sort();

	const ex1 = renumberBy('exact');
	const schedules = Array.isArray(page.body.schedules)
		? (page.body.schedules as Json[]).map((s) => ({
				...s,
				locomotives: (Array.isArray(s.locomotives) ? s.locomotives : []).map((l) => ex1.map.get(num(l)) ?? -1).sort((a, b) => a - b)
			}))
		: null;
	const stock = Array.isArray(page.body.stock_connections)
		? (page.body.stock_connections as Json[])
				.map((s) => stable(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, ex1.map.get(num(v)) ?? -1]))))
				.sort(cmp)
		: null;
	const exact = await sha256(
		stable({
			e: ex1.order.map((r) => r.exact),
			t: tileRows(false),
			w: canonicalWires(wires, ex1.map),
			s: schedules,
			c: stock,
			p: page.body.parameters ?? null
		})
	);
	const la = renumberBy('layout');
	const layout = await sha256(stable({ e: la.order.map((r) => r.layout), t: tileRows(true), w: canonicalWires(wires, la.map) }));
	return { path: page.path, label: str(page.body.label), entities: entities.length, tiles: tiles.length, exact, layout };
}

/** Fingerprints of a decoded exchange string's pages, and of the book when it is one. */
export async function fingerprintPrint(decoded: unknown): Promise<PrintFingerprint> {
	const pages: PageFingerprint[] = [];
	for (const raw of walk(decoded, [], null)) {
		const fp = await pageFingerprint(raw);
		if (fp) pages.push(fp);
	}
	const size = pages.reduce((n, p) => n + p.entities + p.tiles, 0);
	const isBook = !!decoded && typeof decoded === 'object' && 'blueprint_book' in decoded;
	if (pages.length === 0) return { pages, whole: null, book: null };
	const join = (hashes: string[]) => sha256(hashes.join(','));
	const book = isBook
		? {
				exact: await join(pages.map((p) => p.exact)),
				layout: await join(pages.map((p) => p.layout)),
				exactSet: await join(pages.map((p) => p.exact).sort(cmp)),
				layoutSet: await join(pages.map((p) => p.layout).sort(cmp))
			}
		: null;
	const whole =
		pages.length === 1 || !book
			? { exact: pages[0].exact, layout: pages[0].layout, size }
			: { exact: book.exact, layout: book.layout, size };
	return { pages, whole, book };
}
