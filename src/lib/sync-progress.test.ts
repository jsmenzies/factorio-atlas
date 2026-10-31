import { describe, expect, test } from 'bun:test';
import { foldProgress, progressFileOf, recordsSeen, type ProgressEvent } from './sync-progress';

/** Events as the 2026-10-30 update's lines would give them: the fetch, then the gate. */
const EVENTS: ProgressEvent[] = [
	{ t: 'step', step: 'removals' },
	{ t: 'step', step: 'fetch' },
	{ t: 'record', site: 'codex', outcome: 'new' },
	{ t: 'record', site: 'codex', outcome: 'new' },
	{ t: 'record', site: 'fprints', outcome: 'new' },
	{ t: 'step', step: 'ingest' },
	{ t: 'command', command: 'scripts/polled.ts --stage prod --site codex --dir /home/james/data/factorio-records --yes --json' },
	{ t: 'admit', site: 'codex', records: 431 },
	{ t: 'record', site: 'codex', outcome: 'joined' },
	{ t: 'record', site: 'codex', outcome: 'new' },
	{ t: 'record', site: 'codex', outcome: 'failed' },
	{ t: 'record', site: 'codex', outcome: 'failed' },
	{ t: 'admit', site: 'fprints', records: 407 },
	{ t: 'record', site: 'fprints', outcome: 'undecodable' },
	{ t: 'record', site: 'fprints', outcome: 'new' }
];
const jsonl = (events: ProgressEvent[]) => events.map((e) => `${JSON.stringify(e)}\n`).join('');

describe('foldProgress', () => {
	test("counts only the current step's part: the gate's outcomes and totals per site", () => {
		const p = foldProgress(jsonl(EVENTS));
		expect(p.step).toBe('ingest');
		expect(p.toAdmit).toEqual({ codex: 431, fprints: 407 });
		expect(p.sites).toEqual({ codex: { joined: 1, new: 1, failed: 2 }, fprints: { undecodable: 1, new: 1 } });
		expect(p.command).toBe('scripts/polled.ts --stage prod --site codex --dir /home/james/data/factorio-records --yes --json');
		expect(recordsSeen(p, 'codex')).toBe(4);
	});

	test('the fetch: records read so far, per site', () => {
		const p = foldProgress(
			jsonl(
				EVENTS.slice(
					0,
					EVENTS.findIndex((e) => e.t === 'step' && e.step === 'ingest')
				)
			)
		);
		expect(p.step).toBe('fetch');
		expect(p.sites).toEqual({ codex: { new: 2 }, fprints: { new: 1 } });
		expect(p.toAdmit).toEqual({});
		expect(p.command).toBeNull();
	});

	test('nothing before the first step', () => {
		expect(foldProgress('')).toEqual({
			step: null,
			sites: {},
			toAdmit: {},
			shots: { toCopy: null, bySite: {}, last: null },
			command: null
		});
	});

	test("screenshots from other sites and the step's last command; a broken line is skipped", () => {
		const events = jsonl([
			{ t: 'step', step: 'screenshots' },
			{ t: 'command', command: 'scripts/screenshots.ts --from-clone /x --json' },
			{ t: 'command', command: 'scripts/screenshots.ts --from-sites prod --json' },
			{ t: 'shots', toCopy: 716 },
			{ t: 'shot', site: 'codex', outcome: 'fetched' },
			{ t: 'shot', site: 'codex', outcome: 'failed' },
			{ t: 'shot', site: 'fprints', outcome: 'fetched' }
		]);
		expect(foldProgress(`${events}{"t":"shot","site":"fpr`)).toEqual({
			step: 'screenshots',
			sites: {},
			toAdmit: {},
			shots: { toCopy: 716, bySite: { codex: { fetched: 1, failed: 1 }, fprints: { fetched: 1, failed: 0 } }, last: 'fprints' },
			command: 'scripts/screenshots.ts --from-sites prod --json'
		});
	});

	test('the file sits beside the log', () => {
		expect(progressFileOf('sync-2026-10-31T09-47-25-289Z.log')).toBe('sync-2026-10-31T09-47-25-289Z.progress.jsonl');
	});
});
