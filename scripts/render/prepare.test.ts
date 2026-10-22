import { describe, expect, test } from 'bun:test';
import { gameCatalog } from '#lib/viewer/catalog.server.js';
import { entityCount, moddedNames, PageCache, prepared, preparedSkipped, shifted, skipReason, type Prepared } from './prepare.js';
import { blueprintPages, type BlueprintPage } from './source.js';

/** Factorio's packed version 2.0.0.0 (major << 48). */
const V2 = 2 * 2 ** 48;
const V1 = 2 ** 48 + 2 ** 32;
const db = { entities: { 'transport-belt': {}, 'assembling-machine-1': {} }, tiles: { concrete: {} } } as never;

const page = (blueprint: Record<string, unknown>, version: BlueprintPage['version'] = [2, 0, 0, 0]): BlueprintPage => ({
	path: '',
	label: null,
	version,
	blueprint
});
const belt = (x: number, y: number, name = 'transport-belt') => ({ entity_number: 1, name, position: { x, y } });

describe('skipReason', () => {
	test('pre-2.0 pages are skipped unless the print is a favourite', () => {
		const p = page({ version: V1, entities: [belt(0.5, 0.5)] }, [1, 1, 0, 0]);
		expect(skipReason(db, p, false)).toBe('pre-2.0');
		expect(skipReason(db, p, true)).toBeNull();
	});

	test('a page with no entities or tiles is empty', () => {
		expect(skipReason(db, page({ version: V2 }), false)).toBe('empty');
		expect(skipReason(db, page({ version: V2, entities: [], tiles: [] }), true)).toBe('empty');
	});

	test('entities and tiles fpsr has no sprites for, sorted, at most 12 named', () => {
		const p = page({
			version: V2,
			entities: [belt(0.5, 0.5, 'zz-mod'), belt(1.5, 0.5)],
			tiles: [{ name: 'aa-tile', position: { x: 0, y: 0 } }]
		});
		expect(moddedNames(db, p.blueprint)).toEqual(['aa-tile', 'zz-mod']);
		expect(skipReason(db, p, false)).toBe('modded: aa-tile, zz-mod');
		const many = page({
			version: V2,
			entities: Array.from({ length: 14 }, (_, i) => belt(i + 0.5, 0.5, `m${String(i).padStart(2, '0')}`))
		});
		expect(skipReason(db, many, false)).toBe(
			`modded: ${Array.from({ length: 12 }, (_, i) => `m${String(i).padStart(2, '0')}`).join(', ')}, … (14)`
		);
	});

	test('a 2.0 page of known entities is drawn', () => {
		expect(skipReason(db, page({ version: V2, entities: [belt(0.5, 0.5)] }), false)).toBeNull();
		expect(skipReason(db, page({ version: V2, tiles: [{ name: 'concrete', position: { x: 0, y: 0 } }] }), false)).toBeNull();
	});
});

describe('shifted', () => {
	test('no offset: the very same blueprint', () => {
		const bp = { entities: [belt(0.5, 0.5)] };
		expect(shifted(bp, [0, 0])).toBe(bp);
	});

	test('moves entity positions only', () => {
		const bp = { version: V1, entities: [belt(1, 2)], tiles: [{ name: 'concrete', position: { x: 3, y: 4 } }] };
		expect(shifted(bp, [0.5, -0.5])).toEqual({ ...bp, entities: [{ ...belt(1, 2), position: { x: 1.5, y: 1.5 } }] });
		expect(bp.entities[0].position).toEqual({ x: 1, y: 2 });
	});
});

describe('prepared', () => {
	test('a skipped page is keyed by its blueprint as decoded', () => {
		const p = page({ version: V2, entities: [belt(0.5, 0.5, 'zz-mod')] });
		expect(preparedSkipped(p)).toEqual({ json: JSON.stringify(p.blueprint), offset: [0, 0], page: '' });
	});

	test('an aligned 2.0 page goes to fpsr as decoded, with its page data', () => {
		const decoded = { blueprint: { item: 'blueprint', version: V2, entities: [belt(0.5, 0.5)] } };
		const [p] = [...blueprintPages(decoded)];
		const out = prepared(gameCatalog(), decoded, p);
		expect(out.json).toBe(JSON.stringify(p.blueprint));
		expect(out.offset).toEqual([0, 0]);
		expect(JSON.parse(out.page)).toMatchObject({ path: '' });
		expect(entityCount(p)).toBe(1);
	});
});

describe('PageCache', () => {
	const prep = (n: number): Prepared => ({ json: 'x'.repeat(n), offset: [0, 0], page: '' });

	test('keeps pages while they fit, and hands each out once', () => {
		const cache = new PageCache(100);
		expect(cache.offer('a', '', prep(60))).toBe(true);
		expect(cache.offer('a', '1', prep(40))).toBe(false);
		expect(cache.offer('b', '', prep(39))).toBe(true);
		expect(cache.bytes).toBe(99);
		expect(cache.take('a', '')?.json.length).toBe(60);
		expect(cache.take('a', '')).toBe(undefined);
		expect(cache.bytes).toBe(39);
	});

	test('offering a page again replaces it without counting it twice', () => {
		const cache = new PageCache(100);
		cache.offer('a', '', prep(50));
		expect(cache.offer('a', '', prep(60))).toBe(true);
		expect(cache.bytes).toBe(60);
	});
});
