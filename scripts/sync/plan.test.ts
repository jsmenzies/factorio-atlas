import { describe, expect, test } from 'bun:test';
import type { SourcePlan, SourceRun } from '#lib/sync.js';
import { upToDateLine } from '#lib/components/admin/sync/view.js';
import { failedPlan, plansAfterFetch, resolveAccept } from './plan';

const level = (site: string, id: string): SourcePlan => ({
	site,
	from: { id, date: 1 },
	to: { id, date: 1 },
	prints: 10,
	added: 0,
	edited: 0,
	favourites: 0,
	deleted: [],
	modern: 0,
	blocked: null
});

describe('the plan the fetch step saves', () => {
	test('a source whose plan failed stays in it, with its error, so the Overview never calls it up to date', () => {
		const codex = failedPlan({ site: 'codex', polled: true }, 'HTTP 522');
		expect(codex).toMatchObject({ site: 'codex', polled: true, error: 'HTTP 522', added: 0 });
		const plans = [level('factorioprints', 'abc'), level('uploads', 'none'), codex];
		const sources: SourceRun[] = [
			{ site: 'codex', from: null, to: null, polled: true },
			{ site: 'factorioprints', from: { id: 'abc', date: 1 }, to: { id: 'abc', date: 1 } },
			{ site: 'uploads', from: { id: 'none', date: 0 }, to: { id: 'none', date: 0 } }
		];
		const after = plansAfterFetch(plans, sources, () => undefined);
		expect(after.map((p) => p.site)).toEqual(['factorioprints', 'uploads', 'codex']);
		expect(after[2]).toEqual(codex);
		expect(upToDateLine({ checkedAt: 0, sources: after })).toEqual({
			text: '2 of 3 sources up to date · codex couldn’t be checked',
			complete: false
		});
	});

	test('a fetched polled site is level at its new cursor, with the reads it left', () => {
		const p: SourcePlan = { ...level('fprints', '0@0'), polled: true, to: { id: '432@5:x', date: 5 }, added: 432 };
		const to = { id: '432@5:x+32', date: 5 };
		const [after] = plansAfterFetch(
			[p],
			[{ site: 'fprints', from: p.from, to, polled: true, counts: { left: 32 } }],
			() => '400 prints on this machine'
		);
		expect(after).toMatchObject({ from: to, to, added: 0, position: '400 prints on this machine', stateText: '32 left' });
	});
});

const errorOf = (r: ReturnType<typeof resolveAccept>) => ('error' in r ? r.error : '');

describe('resolveAccept: --accept <commit|site|site:id>', () => {
	const mirror: SourcePlan = {
		...level('factorioprints', 'aaa'),
		to: { id: 'afb755bc880a13a3', date: 2 },
		blocked: '30 new, 0 removed: …'
	};
	const codex: SourcePlan = {
		...level('codex', '466@1'),
		to: { id: '528@2:abcdef', date: 2 },
		polled: true,
		blocked: '62 new, 0 removed: …'
	};
	const fprints = level('fprints', '432@1');
	const sources = [mirror, codex, fprints];

	test('a mirror commit by its hash, as before', () => {
		expect(resolveAccept('afb755b', sources, 'factorioprints')).toEqual({ site: 'factorioprints', id: 'afb755bc880a13a3' });
		expect('error' in resolveAccept('0123456', sources, 'factorioprints')).toBe(true);
	});

	test('a polled site by name takes the change the last check held back; site:id must match it', () => {
		expect(resolveAccept('codex', sources, 'factorioprints')).toEqual({ site: 'codex', id: '528@2:abcdef' });
		expect(resolveAccept('codex:528@2:abcdef', sources, 'factorioprints')).toEqual({ site: 'codex', id: '528@2:abcdef' });
		expect(resolveAccept('factorioprints', sources, 'factorioprints')).toEqual({ site: 'factorioprints', id: 'afb755bc880a13a3' });
		expect(errorOf(resolveAccept('codex:999@3:x', sources, 'factorioprints'))).toContain('not 999@3:x');
		// Not held back, or not a source.
		expect(errorOf(resolveAccept('fprints', sources, 'factorioprints'))).toContain("didn't hold fprints back");
		expect('error' in resolveAccept('Codex!', sources, 'factorioprints')).toBe(true);
	});
});
