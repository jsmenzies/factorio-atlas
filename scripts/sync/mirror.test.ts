import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureRecord } from '#lib/server/fixtures.js';
import { changesByID, favouritesOnly, idOf, planMirror, pullMirror, sourceKind, structural } from './mirror';

describe('changesByID', () => {
	test('a record that moved is one modified print, not a deletion and an addition', () => {
		const c = changesByID(['A\tnew/-New.json', 'D\told/-Old.json', 'M\tm/-Mod.json', 'M\tREADME.md'].join('\n'));
		expect(c.added).toEqual(['-New']);
		expect(c.deleted).toEqual(['-Old']);
		expect(c.modified).toEqual([{ id: '-Mod', from: 'm/-Mod.json', to: 'm/-Mod.json' }]);
		expect(changesByID('D\t-ab/-AbX.json\nA\t-ab2/-AbX.json').modified).toEqual([
			{ id: '-AbX', from: '-ab/-AbX.json', to: '-ab2/-AbX.json' }
		]);
		expect(idOf('README.md')).toBeNull();
	});
});

describe('favouritesOnly', () => {
	test('favourites alone are not an edit; anything else, or unreadable JSON, is', () => {
		const a = JSON.stringify({ title: 't', favorites: { u1: true }, numberOfFavorites: 1 });
		expect(favouritesOnly(a, JSON.stringify({ title: 't', favorites: { u1: true, u2: true }, numberOfFavorites: 2 }))).toBe(true);
		expect(favouritesOnly(a, JSON.stringify({ title: 'u', favorites: { u1: true }, numberOfFavorites: 1 }))).toBe(false);
		expect(favouritesOnly(a, '{')).toBe(false);
	});
});

describe('planMirror on a real git clone', () => {
	let dir: string;
	const git = (cwd: string, ...args: string[]) => {
		// Never the user's signing setup: the temp repo's commits are unsigned.
		const config = ['user.name=t', 'user.email=t@example.com', 'init.defaultBranch=main', 'commit.gpgsign=false', 'tag.gpgsign=false'];
		const r = spawnSync('git', [...config.flatMap((c) => ['-c', c]), ...args], {
			cwd,
			encoding: 'utf8'
		});
		if (r.status !== 0) throw new Error(r.stderr);
		return r.stdout.trim();
	};
	const put = (repo: string, path: string, text: string) => {
		mkdirSync(join(repo, path, '..'), { recursive: true });
		writeFileSync(join(repo, path), text);
	};
	const record = (title: string, favourites: number, blueprintString = '') =>
		JSON.stringify({ title, numberOfFavorites: favourites, blueprintString });

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'sync-mirror-'));
		const origin = join(dir, 'origin');
		mkdirSync(origin);
		git(origin, 'init', '-q');
		put(origin, '-a/-A.json', record('a', 1));
		put(origin, '-b/-B.json', record('b', 1));
		put(origin, '-c/-C.json', record('c', 1));
		put(origin, 'x/-E.json', record('e', 1));
		git(origin, 'add', '.');
		git(origin, 'commit', '-qm', 'one');
		git(dir, 'clone', '-q', 'origin', 'clone');
		// The mirror's next update: favourites, a real edit, a deletion, a new 2.0 print, a moved file.
		const space2 = (JSON.parse(await fixtureRecord('-OBuERtPdm2_2an2RSMS')) as { blueprintString: string }).blueprintString;
		put(origin, '-a/-A.json', record('a', 2));
		put(origin, '-b/-B.json', record('b, edited', 1));
		rmSync(join(origin, '-c/-C.json'));
		put(origin, '-d/-D.json', record('d', 0, space2));
		rmSync(join(origin, 'x/-E.json'));
		put(origin, 'y/-E.json', record('e', 1));
		git(origin, 'add', '-A');
		git(origin, 'commit', '-qm', 'two');
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test('says what the next commit changes, by print, without moving the clone', async () => {
		const clone = join(dir, 'clone');
		const head = git(clone, 'rev-parse', 'HEAD');
		// A test mirror of 4 prints changes them all, so the guard is set out of reach here.
		const plan = await planMirror(clone, { maxChange: 10 });
		expect(plan).toMatchObject({
			site: 'factorioprints',
			prints: 4,
			added: 1,
			edited: 1,
			favourites: 2,
			deleted: ['-C'],
			modern: 1,
			blocked: null
		});
		expect(plan.from.id).toBe(head);
		expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);

		expect((await pullMirror(clone, plan.to.id)).id).toBe(plan.to.id);
		expect(await planMirror(clone, { maxChange: 10 })).toMatchObject({ added: 0, deleted: [], from: plan.to, to: plan.to });
	});

	test('a small change is never held back: the floor of 25 prints', async () => {
		const clone = join(dir, 'clone2');
		git(dir, 'clone', '-q', 'origin', 'clone2');
		git(clone, 'reset', '-q', '--hard', 'HEAD~1');
		// Added -D, deleted -C, moved -E: 3 of 4 prints, but under 25.
		expect((await planMirror(clone, { maxChange: 0.05 })).blocked).toBeNull();
	});

	test('held back past the share of the clone’s prints: new only, removed only; edits never count; accept lets it through', async () => {
		const origin = join(dir, 'big');
		mkdirSync(origin);
		git(origin, 'init', '-q');
		const ids = Array.from({ length: 60 }, (_, i) => `-P${String(i).padStart(3, '0')}`);
		for (const id of ids) put(origin, `${id.slice(0, 2).toLowerCase()}/${id}.json`, record(id, 1));
		git(origin, 'add', '.');
		git(origin, 'commit', '-qm', 'base');
		git(dir, 'clone', '-q', 'big', 'bigclone');
		const clone = join(dir, 'bigclone');
		const commit = (msg: string, change: () => void) => {
			change();
			git(origin, 'add', '-A');
			git(origin, 'commit', '-qm', msg);
			return git(origin, 'rev-parse', 'HEAD');
		};
		// Every print edited: not held back.
		commit('edits', () => ids.forEach((id) => put(origin, `${id.slice(0, 2).toLowerCase()}/${id}.json`, record(`${id} edited`, 1))));
		expect((await planMirror(clone, { maxChange: 0.05 })).blocked).toBeNull();
		await pullMirror(clone, git(origin, 'rev-parse', 'HEAD'));
		// 30 new (over 25 and 5% of 60): held back, with its counts.
		const added = commit('new', () => Array.from({ length: 30 }, (_, i) => put(origin, `-n/-N${i}.json`, record(`n${i}`, 0))));
		const held = await planMirror(clone, { maxChange: 0.05 });
		expect(held.blocked).toBe(
			"30 new, 0 removed: more than 5% (25 at least) of 60; check the mirror (a layout change?), then accept it if it's right"
		);
		expect(held.modern).toBe(0);
		expect((await planMirror(clone, { maxChange: 0.05, accept: added })).blocked).toBeNull();
		expect((await planMirror(clone, { maxChange: 0.05, accept: held.from.id })).blocked).not.toBeNull();
		await pullMirror(clone, added);
		// 30 removed of 90: held back too.
		commit('gone', () => ids.slice(0, 30).forEach((id) => rmSync(join(origin, `${id.slice(0, 2).toLowerCase()}/${id}.json`))));
		expect((await planMirror(clone, { maxChange: 0.05 })).blocked).toContain('0 new, 30 removed: more than 5% (25 at least) of 90');
	});

	test('a first import (a clone with no prints yet) is held back once for Accept', async () => {
		const origin = join(dir, 'fresh');
		mkdirSync(origin);
		git(origin, 'init', '-q');
		put(origin, 'README.md', 'mirror');
		git(origin, 'add', '.');
		git(origin, 'commit', '-qm', 'empty');
		git(dir, 'clone', '-q', 'fresh', 'freshclone');
		put(origin, '-a/-A.json', record('a', 1));
		git(origin, 'add', '.');
		git(origin, 'commit', '-qm', 'first');
		const plan = await planMirror(join(dir, 'freshclone'), { maxChange: 0.05 });
		expect(plan.blocked).toContain('1 new, 0 removed: a first import');
		expect((await planMirror(join(dir, 'freshclone'), { maxChange: 0.05, accept: plan.to.id })).blocked).toBeNull();
	});

	test("names the source from the clone's origin", () => {
		expect(sourceKind('https://github.com/motlin/factorio-blueprint-firebase-cdn.git\n')).toBe(
			'GitHub mirror motlin/factorio-blueprint-firebase-cdn'
		);
		expect(sourceKind('git@github.com:motlin/factorio-blueprint-firebase-cdn.git')).toBe(
			'GitHub mirror motlin/factorio-blueprint-firebase-cdn'
		);
		expect(sourceKind('/tmp/origin')).toBe('git mirror /tmp/origin');
	});

	test('edits in place are not a layout change', () => {
		expect(structural(changesByID('M\t-a/-A.json\nM\t-b/-B.json'))).toBe(0);
		expect(structural(changesByID('A\t-d/-D.json\nD\t-c/-C.json\nD\tx/-E.json\nA\ty/-E.json\nM\t-a/-A.json'))).toBe(3);
	});

	test('holds back a clone whose history the mirror no longer has', async () => {
		const clone = join(dir, 'clone4');
		git(dir, 'clone', '-q', 'origin', 'clone4');
		git(clone, 'reset', '-q', '--hard', 'HEAD~1');
		put(clone, '-z/-Z.json', record('z', 0));
		git(clone, 'add', '-A');
		git(clone, 'commit', '-qm', 'local');
		const plan = await planMirror(clone, { maxChange: 10 });
		expect(plan.blocked).toContain('its history was rewritten');
		expect(plan.added).toBe(0);
	});

	test('stops when the mirror would be left with no prints, whatever the limit', async () => {
		const origin = join(dir, 'origin');
		git(origin, 'rm', '-rq', '.');
		put(origin, 'README.md', 'moved');
		git(origin, 'add', '-A');
		git(origin, 'commit', '-qm', 'three');
		const clone = join(dir, 'clone3');
		git(dir, 'clone', '-q', 'origin', 'clone3');
		git(clone, 'reset', '-q', '--hard', 'HEAD~1');
		const plan = await planMirror(clone, { maxChange: 10 });
		expect(plan.prints).toBe(0);
		expect(plan.blocked).toContain('has no prints (4 now)');
	});
});
