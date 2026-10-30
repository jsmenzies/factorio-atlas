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
		expect(p.shots).toEqual({ toCopy: 716, bySite: { codex: { fetched: 1, failed: 1 }, fprints: { fetched: 1, failed: 0 } } });
		expect(p.sites).toEqual({});
	});

	test('nothing before the first header', () => {
		expect(logProgress('sync 2026… → prod\n')).toEqual({
			step: null,
			sites: {},
			toAdmit: {},
			shots: { toCopy: null, bySite: {} },
			render: null
		});
	});
});

// The render step as the 2026-10-30 22:42 update wrote it (sync-2026-10-30T22-42-36-541Z.log), shortened.
const RENDER = `== Render and upload
$ bun scripts/render-scope.ts top 1000 --from-clone /home/james/data/factorio-mirror --json
{"n":1000,"source":"clone@afb755bc","prints":18226,"parsed":0,"cutoff":26,"refreshed_at":1793400349931,"ms":119,"former":1}
$ bun scripts/render-game.ts --from-clone /home/james/data/factorio-mirror --records /home/james/data/factorio-records --next 50 --top 1000 --upload prod --flags --workers 4
renders: /home/james/data/factorio-renders
run 2026-10-30T22:46:02Z-es1r: --from-clone /home/james/data/factorio-mirror --records /home/james/data/factorio-records --next 50 --top 1000 --upload prod --flags --workers 4
queued 451 pages of 454 (0 unchanged, 3 skipped, 0 failed) from 52 prints in 6.9 s; 5 prints (105 pages) with no 2.0+ page and 1 with no blueprint pages (planners only) left out
  codex-164 26      11617 ents  134×356 tiles → 670×1780@5 + 16:5×12 32:9×23 64:17×45, 36.3 MB, 719 files (14 reused, 302 empty, 297 never drawn), 56.9 s, peak 2340 MB
  ↑ codex-164 26     719 files, 36.3 MB (0 tiles already up)
`;

describe('logProgress: the render run', () => {
	test('none before its runner starts; drawing once it has', () => {
		const before = RENDER.slice(0, RENDER.indexOf('renders:'));
		expect(logProgress(before)).toMatchObject({ step: 'render', render: null });
		expect(logProgress(RENDER).render).toEqual({ phase: 'drawing', thumbs: null, uploadsLeft: null, ended: null, flags: null });
	});

	test('thumbnails after the last page: prints done of those offered', () => {
		const p = logProgress(
			RENDER +
				"rendering done; bringing 20 prints' thumbnails up to date\n" +
				'thumbnails: 30 of 50 prints made and uploaded\n' +
				'  ↑ codex-129 6/1/0/12 39 files, 2.5 MB (16 tiles already up)\n' +
				'thumbnails: 37 of 50 prints made and uploaded\n'
		);
		expect(p.render).toMatchObject({ phase: 'thumbnails', thumbs: { done: 37, of: 50, upload: true } });
		// The run's own summary line starts the same way but is not a progress line.
		const end = logProgress(
			RENDER + 'thumbnails: 170 pages made (505 files, 20.1 MB), 1 of 29 prints up to date, 0 old files deleted from disk\n'
		);
		expect(end.render?.thumbs).toBeNull();
	});

	test('uploads, deletions, the end line, then the flags', () => {
		const ended =
			RENDER +
			'rendering done; waiting for 3 pages to upload\n' +
			'deletions: deleting replaced files whose grace period is over\n' +
			'finished: 454/454 pages (50/50 prints), 451 rendered, 0 unchanged, 3 skipped, 0 failed; 21814 files, 1043.2 MB in 1820 s\n' +
			'thumbnails: 2310 pages made (6905 files, 270.1 MB), 2 of 52 prints up to date, 0 old files deleted from disk\n' +
			'uploads: 451 pages, 21814 files, 1043.2 MB, 0 deleted; 0 deletions scheduled / 0 pending; 0 pages still to upload\n';
		expect(logProgress(RENDER + 'rendering done; waiting for 3 pages to upload\n').render).toMatchObject({
			phase: 'uploads',
			uploadsLeft: 3
		});
		expect(logProgress(RENDER + 'deletions: deleting replaced files whose grace period is over\n').render?.phase).toBe('deletions');
		expect(logProgress(ended).render).toMatchObject({
			phase: 'finishing',
			ended: { state: 'finished', prints: 50, printsOf: 50, rendered: 451, failed: 0, uploaded: 451 }
		});
		const flags = logProgress(ended + 'flags: render:flags --stage prod, and a page-cache bump\n5,483 prints have a render for prod\n');
		expect(flags.render).toMatchObject({ phase: 'flags', flags: { stage: 'prod', failed: false } });
		expect(logProgress(ended + 'flags: render:flags --stage local\n').render?.flags).toEqual({ stage: 'local', failed: false });
		const failed = logProgress(ended + 'flags: render:flags --stage prod\nflags: failed: remote /d1: Network connection lost.\n');
		expect(failed.render?.flags).toEqual({ stage: 'prod', failed: true });
	});

	test('only in the render step', () => {
		expect(logProgress(`== Update the site's prints\nrun 2026-10-30T22:46:02Z-abcd: --stage prod\n`).render).toBeNull();
	});
});
