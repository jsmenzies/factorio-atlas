/**
 * The screenshots step's bucket figures for the Overview: approved upload screenshots in "From uploads", the
 * rest (Imgur copies) in the stage's bucket group. `screenshots --upload --json` counts both in its totals and
 * the upload images again under `uploads`, so the bucket group takes those out: each file counts once.
 */
import { detail, GROUP, megabytes, ROW, type DetailGroup, type StepFigures } from '#lib/sync.js';
import type { UploadRunResult } from '../screenshots/run';
import type { FromUploadsResult } from '../screenshots/uploads';

const filesPut = (put: number, bytes: number) => (put ? `${put.toLocaleString('en-US')} (${megabytes(bytes)})` : 0);

/** A bucket count, less the upload images' when they have their own group (`uploaded`). */
const bucketCount = (uploaded: FromUploadsResult | null, bucket: UploadRunResult, key: keyof UploadRunResult['uploads']) =>
	bucket[key] - (uploaded ? (bucket.uploads?.[key] ?? 0) : 0);

/** The board's Sizing and upload figures: the files the bucket group counts, and their bytes. */
export const bucketPut = (uploaded: FromUploadsResult | null, bucket: UploadRunResult | null): StepFigures['bucketPut'] =>
	bucket ? { files: bucketCount(uploaded, bucket, 'put'), bytes: bucketCount(uploaded, bucket, 'bytes') } : undefined;

export function screenshotBucketDetails(stage: string, uploaded: FromUploadsResult | null, bucket: UploadRunResult | null): DetailGroup[] {
	const details: DetailGroup[] = [];
	const u = bucket?.uploads;
	if (uploaded)
		details.push({
			title: GROUP.fromUploads,
			rows: [
				...detail(ROW.approved, uploaded.approved, { always: true }),
				...detail(ROW.copiedFromRaw, uploaded.fetched),
				...detail(ROW.sized, u?.made ?? 0, { always: uploaded.toFetch > 0 }),
				...detail(ROW.alreadyUp, u?.alreadyUp ?? 0),
				{ label: ROW.filesPut, value: filesPut(u?.put ?? 0, u?.bytes ?? 0) },
				...detail(ROW.deleted, u?.deleted ?? 0),
				...detail(ROW.failed, uploaded.failed + (u?.failed ?? 0), { always: true, tone: 'bad' })
			]
		});
	if (bucket) {
		// Without `uploaded` the upload images have no group of their own, so they stay in the bucket's.
		const less = (key: keyof UploadRunResult['uploads']) => bucketCount(uploaded, bucket, key);
		details.push({
			title: GROUP.bucket(stage),
			rows: [
				...detail(ROW.alreadyUp, less('alreadyUp'), { always: true }),
				...detail(ROW.sizesMade, less('made')),
				{ label: ROW.filesPut, value: filesPut(less('put'), less('bytes')) },
				{ label: ROW.deleted, value: less('deleted') },
				...detail(ROW.failed, less('failed'), { always: true, tone: 'bad' })
			]
		});
	}
	return details;
}
