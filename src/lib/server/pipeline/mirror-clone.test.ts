import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloneError, cloneCommit, listClone, readCloneRecord } from './mirror-clone';

const A = '-KYpTULTDIvDOsJfgjeS';
const B = '-KYVL2qnlOpHomJAj-eB';
const C = 'AbcdefghijklmnopqrsT';

const put = (dir: string, path: string, text: string) => {
	mkdirSync(join(dir, path, '..'), { recursive: true });
	writeFileSync(join(dir, path), text);
};
const git = (dir: string, ...args: string[]) =>
	spawnSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
		encoding: 'utf8'
	}).stdout.trim();

/** A tiny clone in a temporary folder: two shards, the watermark, a .git, and files that aren't records. */
const withClone = async (fn: (dir: string) => unknown) => {
	const dir = mkdtempSync(join(tmpdir(), 'mirror-clone-'));
	try {
		put(dir, `-ky/${A}.json`, '{"title":"a"}');
		put(dir, `-ky/${B}.json`, '{"title":"bb"}');
		put(dir, `abc/${C}.json`, '{}');
		put(dir, 'firebase_cdn_watermark.txt', '1760000000000');
		put(dir, '.gitattributes', '*.json -diff');
		put(dir, '-ky/notes.txt', 'not a record');
		put(dir, `zzz/${A}.json`, '{"title":"in the wrong shard"}');
		put(dir, 'abc/short.json', '{}');
		git(dir, 'init', '-q');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-q', '-m', 'mirror');
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const thrown = async (fn: () => unknown) => {
	try {
		await fn();
		return null;
	} catch (e) {
		return e;
	}
};

describe('listClone', () => {
	test('lists the records at their mirror paths, sorted by path, skipping everything else', () =>
		withClone(async (dir) => {
			expect(await listClone(dir)).toEqual([
				{ id: B, path: `-ky/${B}.json`, size: 14 },
				{ id: A, path: `-ky/${A}.json`, size: 13 },
				{ id: C, path: `abc/${C}.json`, size: 2 }
			]);
		}));

	test('reads a record', () =>
		withClone(async (dir) => {
			expect(await readCloneRecord(dir, { path: `-ky/${A}.json` })).toBe('{"title":"a"}');
		}));

	test('a missing folder is a CloneError', async () => {
		expect((await thrown(() => listClone(join(tmpdir(), 'mirror-clone-missing')))) instanceof CloneError).toBe(true);
	});
});

describe('cloneCommit', () => {
	test('the HEAD sha, and dirty once a tracked file changes', () =>
		withClone((dir) => {
			const head = git(dir, 'rev-parse', 'HEAD');
			expect(head.length).toBe(40);
			expect(cloneCommit(dir)).toEqual({ sha: head, dirty: false });
			put(dir, `-ky/${A}.json`, '{"title":"edited"}');
			expect(cloneCommit(dir)).toEqual({ sha: head, dirty: true });
		}));

	test('not a git checkout is a CloneError', async () => {
		const plain = mkdtempSync(join(tmpdir(), 'mirror-plain-'));
		try {
			expect((await thrown(() => cloneCommit(plain))) instanceof CloneError).toBe(true);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
