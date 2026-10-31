import { describe, expect, test } from 'bun:test';
import { logProgress, recordsSeen } from './sync-progress';

// Lines as the 2026-10-30 update wrote them (sync-2026-10-30T12-00-29-288Z.log).
const LOG = `== Apply removals
✓ Apply removals: nothing to do

== Fetch new prints
codex/14: new
codex/31: new
fprints/fbed9394-3f2c-462a-8929-13d345db4f7d: new
✓ Fetch new prints: …

== Update the site's prints
$ bun scripts/polled.ts --stage prod --site codex --dir /home/james/data/factorio-records --yes --json
  ⎔ Establishing remote connection...
prod ← codex inbox /home/james/data/factorio-records/.polled/codex: 431 records to admit, 0 gone from the site
codex/14: joined (-OAOIJs5EGc4EWrUeWmp)
codex/34: new
codex/323: failed (remote /d1: D1_ERROR: Failed to parse body as JSON, got: Error: Network connection lost.
codex/324: failed (remote /d1: D1_ERROR: Network connection lost.)
prod ← fprints inbox /home/james/data/factorio-records/.polled/fprints: 407 records to admit, 0 gone from the site
fprints/2d100906-557b-434a-99bd-b2029c0345bb: undecodable (unsupported version byte "h")
fprints/7a479873-899e-4c8c-a983-97f2f14c6460: new
`;

describe('logProgress', () => {
	test("counts only the current step's part: the gate's outcomes and totals per site", () => {
		const p = logProgress(LOG);
		expect(p.step).toBe('ingest');
		expect(p.toAdmit).toEqual({ codex: 431, fprints: 407 });
		expect(p.sites).toEqual({ codex: { joined: 1, new: 1, failed: 2 }, fprints: { undecodable: 1, new: 1 } });
		expect(recordsSeen(p, 'codex')).toBe(4);
	});

	test('the fetch: records read so far, per site', () => {
		const p = logProgress(LOG.slice(0, LOG.indexOf('== Update')));
		expect(p.step).toBe('fetch');
		expect(p.sites).toEqual({ codex: { new: 2 }, fprints: { new: 1 } });
	});

	test("screenshots from other sites: the total to copy, and each site's copies and failures", () => {
		const p = logProgress(`== Copy screenshots
screenshots: 18111 already copied, 2 dead; to fetch 0 (0 failed before, 0 files missing, 0 dead rechecked) → /x
screenshots: 749 images from other sites shown in prod: 33 already copied, 0 dead, 0 removed; to copy 716 → /x
screenshots: codex.2cc33feefb7dd975 (codex-34): fetched
screenshots: codex.ad495edadaac02a8 (codex-108): failed (over 30 MB from factoriocodex.s3.us-west-000.backblazeb2.com)
screenshots: fprints.0f688ce08ceec6a7 (fprints-1a2b): fetched
`);
		expect(p.step).toBe('screenshots');
		expect(p.shots).toEqual({
			toCopy: 716,
			bySite: { codex: { fetched: 1, failed: 1 }, fprints: { fetched: 1, failed: 0 } },
			last: 'fprints'
		});
		expect(p.sites).toEqual({});
	});

	test('nothing before the first header', () => {
		expect(logProgress('sync 2026… → prod\n')).toEqual({
			step: null,
			sites: {},
			toAdmit: {},
			shots: { toCopy: null, bySite: {}, last: null },
			command: null
		});
	});
});

describe('logProgress: the command running now', () => {
	test("the screenshots step's last command; the render step's lines aren't read", () => {
		const p = logProgress(`== Copy screenshots
$ bun scripts/screenshots.ts --from-clone /x --json
screenshots: done in 3s: fetched 0
$ bun scripts/screenshots.ts --from-sites prod --json
`);
		expect(p.command).toBe('scripts/screenshots.ts --from-sites prod --json');
		const r = logProgress(`== Render and upload
$ bun scripts/render-game.ts --next 50 --upload prod --flags
run 2026-10-30T22:46:02Z-es1r: --next 50
thumbnails: 37 of 50 prints made and uploaded
flags: render:flags --stage prod
`);
		expect(r).toEqual({
			step: 'render',
			sites: {},
			toAdmit: {},
			shots: { toCopy: null, bySite: {}, last: null },
			command: 'scripts/render-game.ts --next 50 --upload prod --flags'
		});
	});
});
