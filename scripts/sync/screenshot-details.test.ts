import { expect, test } from 'bun:test';
import type { UploadRunResult } from '../screenshots/run';
import type { FromUploadsResult } from '../screenshots/uploads';
import { screenshotBucketDetails } from './screenshot-details';

const uploaded: FromUploadsResult = {
	mode: 'uploads',
	stage: 'prod',
	approved: 1,
	alreadyCopied: 0,
	removed: 0,
	toFetch: 1,
	fetched: 1,
	failed: 0
};
/** One upload screenshot sized and put (5 files), nothing else to do: the 2026-10-30 update. */
const run = (over: Partial<UploadRunResult> = {}): UploadRunResult => ({
	mode: 'upload',
	target: 'prod',
	images: 18_032,
	made: 1,
	put: 5,
	bytes: 400_000,
	deleted: 0,
	alreadyUp: 18_031,
	failed: 0,
	stopped: false,
	uploads: { images: 1, made: 1, put: 5, bytes: 400_000, deleted: 0, alreadyUp: 0, failed: 0 },
	...over
});
const rows = (groups: ReturnType<typeof screenshotBucketDetails>, title: string) =>
	Object.fromEntries(groups.find((g) => g.title === title)!.rows.map((r) => [r.label, r.value]));

test('an upload screenshot’s files count under From uploads, not again under the bucket', () => {
	const groups = screenshotBucketDetails('prod', uploaded, run());
	expect(groups.map((g) => g.title)).toEqual(['From uploads', 'Prod bucket']);
	expect(rows(groups, 'From uploads')).toEqual({ approved: 1, 'copied from RAW': 1, sized: 1, 'files put': '5 (0.4 MB)', failed: 0 });
	expect(rows(groups, 'Prod bucket')).toEqual({ 'already up': 18_031, 'files put': 0, deleted: 0, failed: 0 });
});

test('each figure is split: Imgur copies in the bucket, upload images in From uploads', () => {
	const groups = screenshotBucketDetails(
		'prod',
		uploaded,
		run({
			made: 3,
			put: 17,
			bytes: 2_000_000,
			deleted: 4,
			alreadyUp: 18_027,
			failed: 2,
			uploads: { images: 2, made: 1, put: 5, bytes: 400_000, deleted: 1, alreadyUp: 1, failed: 1 }
		})
	);
	expect(rows(groups, 'From uploads')).toEqual({
		approved: 1,
		'copied from RAW': 1,
		sized: 1,
		'already up': 1,
		'files put': '5 (0.4 MB)',
		deleted: 1,
		failed: 1
	});
	expect(rows(groups, 'Prod bucket')).toEqual({ 'already up': 18_026, 'sizes made': 2, 'files put': '12 (1.6 MB)', deleted: 3, failed: 1 });
});

test('without the From uploads figures (its run failed), upload images stay in the bucket’s group', () => {
	const groups = screenshotBucketDetails('local', null, run());
	expect(groups.map((g) => g.title)).toEqual(['Local bucket']);
	expect(rows(groups, 'Local bucket')).toEqual({ 'already up': 18_031, 'sizes made': 1, 'files put': '5 (0.4 MB)', deleted: 0, failed: 0 });
});
