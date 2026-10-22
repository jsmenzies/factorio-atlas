import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from '../pipeline/d1-sqlite';
import { parseScopes, scopeStatements } from './render-scope';

const ROOT = join(import.meta.dirname, '../../../..');

const setup = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	const seen = sqlite.query('INSERT INTO render_prints (print_id, stamp, modern, checked_at) VALUES (?, ?, ?, ?)');
	const job = sqlite.query(
		`INSERT INTO render_jobs (print_id, path, input_key, status, reason, attempts, queued_at, uploaded_at) VALUES (?, ?, 'k', ?, ?, 0, 0, ?)`
	);
	const fav = sqlite.query(
		'INSERT INTO render_favorites (print_id, favorites, rank, in_top, refreshed_at, first_added_at) VALUES (?, ?, ?, ?, 0, 0)'
	);
	return { sqlite, db: d1FromSqlite(sqlite), seen, job, fav };
};

describe('render coverage by scope', () => {
	test('2.0+ prints, top favourites and both', async () => {
		const { sqlite, db, seen, job, fav } = setup();
		// 2.0+ only: rendered and up; rendered, not up; pending; all modded; failed and record changed since.
		seen.run('up', 's', 1, 10);
		job.run('up', '', 'done', null, 5);
		seen.run('down', 's', 1, 10);
		job.run('down', '1', 'done', null, null);
		job.run('down', '2', 'skipped', 'pre-2.0', null);
		seen.run('wait', 's', 1, 10);
		job.run('wait', '', 'pending', null, null);
		seen.run('mod', 's', 1, 10);
		job.run('mod', '', 'skipped', 'modded: x', null);
		seen.run('bad', 's', 1, 10);
		job.run('bad', '', 'failed', 'boom', null);
		sqlite.run(`INSERT INTO render_source_changes (print_id, stamp, checked_at) VALUES ('bad', 't', 20), ('up', 't', 5)`);
		// Favourites: `down` (2.0+, its pre-2.0 page still to draw), an old print looked at before the
		// list (no rows), an old rendered one, one never looked at, and a former favourite.
		fav.run('down', 9, 1, 1);
		seen.run('old', 's', 0, 10);
		fav.run('old', 8, 2, 1);
		seen.run('oldok', 's', 0, 10);
		job.run('oldok', '', 'done', null, 7);
		fav.run('oldok', 7, 3, 1);
		fav.run('new', 6, 4, 1);
		fav.run('former', 1, 50, 0);
		const s = parseScopes(await db.batch(scopeStatements(db)));
		expect(s.modern).toEqual({ total: 5, rendered: 2, uploaded: 1, left: 1, none: 1, failed: 1, updated: 1 });
		expect(s.top).toEqual({
			total: 4,
			rendered: 1,
			uploaded: 1,
			left: 3,
			none: 0,
			failed: 0,
			updated: 0,
			modern: 1,
			preModern: 2,
			unseen: 1
		});
		expect(s.union).toEqual({ total: 8, rendered: 2, uploaded: 2, left: 4, none: 1, failed: 1, updated: 1 });
		expect(s.former).toBe(1);
		expect(s.favorites).toBeNull();
	});
});
