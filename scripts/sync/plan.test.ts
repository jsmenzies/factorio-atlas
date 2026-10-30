import { describe, expect, test } from 'bun:test';
import type { SourcePlan, SourceRun } from '#lib/sync.js';
import { upToDateLine } from '#lib/components/admin/sync/view.js';
import { failedPlan, plansAfterFetch } from './plan';

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
	test('a source whose plan failed stays in it, with its kind and error, so the Overview never calls it up to date', () => {
		const codex = failedPlan({ site: 'codex', kind: 'factoriocodex.com API', polled: true }, 'HTTP 522');
		expect(codex).toMatchObject({ site: 'codex', kind: 'factoriocodex.com API', polled: true, error: 'HTTP 522', added: 0 });
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
