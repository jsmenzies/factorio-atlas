/**
 * The screenshots step's bucket figures for the Overview: approved upload screenshots in "From uploads", the
 * rest (Imgur copies) in the stage's bucket group. `screenshots --upload --json` counts both in its totals and
 * the upload images again under `uploads`, so the bucket group takes those out: each file counts once.
 */
import { detail, type DetailGroup } from '#lib/sync.js';
import type { UploadRunResult } from '../screenshots/run';
import type { FromUploadsResult } from '../screenshots/uploads';

const filesPut = (put: number, bytes: number) => (put ? `${put.toLocaleString('en-US')} (${(bytes / 1e6).toFixed(1)} MB)` : 0);

export function screenshotBucketDetails(stage: string, uploaded: FromUploadsResult | null, bucket: UploadRunResult | null): DetailGroup[] {
	const details: DetailGroup[] = [];
	const u = bucket?.uploads;
	if (uploaded)
		details.push({
			title: 'From uploads',
			rows: [
				...detail('approved', uploaded.approved, { always: true }),
				...detail('copied from RAW', uploaded.fetched),
				...detail('sized', u?.made ?? 0, { always: uploaded.toFetch > 0 }),
				...detail('already up', u?.alreadyUp ?? 0),
				{ label: 'files put', value: filesPut(u?.put ?? 0, u?.bytes ?? 0) },
				...detail('deleted', u?.deleted ?? 0),
				...detail('failed', uploaded.failed + (u?.failed ?? 0), { always: true, tone: 'bad' })
			]
		});
	if (bucket) {
		// Without `uploaded` the upload images have no group of their own, so they stay in the bucket's.
		const less = (key: keyof UploadRunResult['uploads']) => bucket[key] - (uploaded ? (u?.[key] ?? 0) : 0);
		details.push({
			title: `${stage[0].toUpperCase()}${stage.slice(1)} bucket`,
			rows: [
				...detail('already up', less('alreadyUp'), { always: true }),
				...detail('sizes made', less('made')),
				{ label: 'files put', value: filesPut(less('put'), less('bytes')) },
				{ label: 'deleted', value: less('deleted') },
				...detail('failed', less('failed'), { always: true, tone: 'bad' })
			]
		});
	}
	return details;
}
