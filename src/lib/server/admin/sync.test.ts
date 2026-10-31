import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from '../pipeline/d1-sqlite';
import { syncOverview } from './sync';

const ROOT = join(import.meta.dirname, '../../../..');

describe('syncOverview: the render runs', () => {
	test('the live run is found even when a newer row (a second start that failed at once) is the latest', async () => {
		const sqlite = new Database(':memory:');
		for (const f of readdirSync(join(ROOT, 'migrations'))
			.filter((f) => f.endsWith('.sql'))
			.sort())
			sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
		const now = 1_000_000_000;
		const run = sqlite.query(
			`INSERT INTO render_runs (id, host, source, options, state, started_at, updated_at, finished_at) VALUES (?, 'h', 's', ?, ?, ?, ?, ?)`
		);
		const stages = { v: 1, at: 0, sites: {}, cleanup: null, flags: null };
		run.run('live', JSON.stringify({ phase: 'thumbnails', stages, batch: { picked: ['x'] } }), 'running', now - 60_000, now - 1000, null);
		run.run('failed', JSON.stringify({}), 'failed', now - 5000, now - 4000, now - 4000);
		const o = await syncOverview(d1FromSqlite(sqlite), now);
		expect(o.liveRender?.id).toBe('live');
		expect(o.liveRender?.options).toEqual({ phase: 'thumbnails', stages });
		expect(o.latestRender?.id).toBe('failed');
		// A live row whose heartbeat stopped is no longer live.
		expect((await syncOverview(d1FromSqlite(sqlite), now + 60_000)).liveRender).toBeNull();
	});
});
