import { describe, expect, test } from 'bun:test';
import { parseR2Storage, readR2Storage, siteBuckets } from './r2-storage';

const answer = (rows: { name: string; at: string; objects: number; bytes: number }[]) => ({
	data: {
		viewer: {
			accounts: [
				{
					r2StorageAdaptiveGroups: rows.map((r) => ({
						max: { objectCount: r.objects, payloadSize: r.bytes },
						dimensions: { bucketName: r.name, datetime: r.at }
					}))
				}
			]
		}
	},
	errors: null
});

describe('R2 storage for the Overview', () => {
	const wanted = siteBuckets('prod');

	test('the stage’s own buckets only, by name', () => {
		expect(wanted.map((b) => b.name)).toEqual([
			'factorio-prints-prod-renders',
			'factorio-prints-prod-screenshots',
			'factorio-prints-prod-raw',
			'factorio-prints-sprites'
		]);
	});

	test('each bucket’s latest point; other buckets ignored; a bucket with no point is 0', () => {
		const got = parseR2Storage(
			answer([
				{ name: 'factorio-prints-prod-renders', at: '2026-10-31T11:00:00Z', objects: 10, bytes: 100 },
				{ name: 'factorio-prints-prod-renders', at: '2026-10-31T11:20:00Z', objects: 12, bytes: 120 },
				{ name: 'factorio-prints-prod-raw', at: '2026-10-31T10:50:00Z', objects: 3, bytes: 30 },
				{ name: 'someone-elses-bucket', at: '2026-10-31T11:30:00Z', objects: 99, bytes: 999 }
			]),
			wanted
		);
		expect(got).toEqual([
			{ kind: 'renders', name: 'factorio-prints-prod-renders', objects: 12, bytes: 120 },
			{ kind: 'screenshots', name: 'factorio-prints-prod-screenshots', objects: 0, bytes: 0 },
			{ kind: 'raw', name: 'factorio-prints-prod-raw', objects: 3, bytes: 30 },
			{ kind: 'sprites', name: 'factorio-prints-sprites', objects: 0, bytes: 0 }
		]);
	});

	test('GraphQL errors and odd answers throw', () => {
		expect(() => parseR2Storage({ errors: [{ message: 'not authorized' }] }, wanted)).toThrow('not authorized');
		expect(() => parseR2Storage({ data: {} }, wanted)).toThrow('no r2StorageAdaptiveGroups');
	});

	test('never throws: no token, HTTP errors and bad answers become the reason', async () => {
		const base = { stage: 'prod' as const, account: () => 'acc', now: 5 };
		expect(await readR2Storage({ ...base, token: undefined })).toEqual({ at: 5, error: 'ANALYTICS_API_TOKEN is not set' });
		const status = (code: number) => (async () => new Response('{}', { status: code })) as unknown as typeof fetch;
		expect(await readR2Storage({ ...base, token: 't', fetch: status(403) })).toEqual({ at: 5, error: 'HTTP 403' });
		let sent: { variables?: { account?: string; buckets?: string[] } } = {};
		const ok = (async (_url: string, init: RequestInit) => {
			sent = JSON.parse(String(init.body));
			return Response.json(answer([{ name: 'factorio-prints-sprites', at: 'x', objects: 1, bytes: 2 }]));
		}) as unknown as typeof fetch;
		const got = await readR2Storage({ ...base, token: 't', fetch: ok });
		expect(sent.variables?.account).toBe('acc');
		expect(sent.variables?.buckets?.length).toBe(4);
		expect('buckets' in got && got.buckets.find((b) => b.kind === 'sprites')).toMatchObject({ objects: 1, bytes: 2 });
	});
});
