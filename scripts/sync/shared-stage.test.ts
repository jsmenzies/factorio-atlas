import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdSharedStage, type HeldStage } from './shared-stage';

/** Stand-ins for scripts/backfill/hold-stage.ts: nothing here opens a stage. */
const dir = mkdtempSync(join(tmpdir(), 'shared-stage-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const STAGE = { stage: 'prod', generation: 1, port: 1, token: 't', pid: 1, database: 'db (id)', bucket: 'raw', account: 'acct' };
const script = (name: string, body: string) => {
	writeFileSync(join(dir, name), body);
	return [join(dir, name)];
};
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const gone = async (pid: number, ms = 5000) => {
	const end = Date.now() + ms;
	while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	return !alive(pid);
};
const hold = (args: string[], over: Partial<Parameters<typeof holdSharedStage>[0]> = {}) => {
	const lines: string[] = [];
	return { lines, held: holdSharedStage({ stage: 'prod', cwd: dir, log: (l) => lines.push(l), stopping: () => false, args, ...over }) };
};

describe('holdSharedStage', () => {
	test("the holder's stage, its progress in the log; dispose ends it and anything left in its group", async () => {
		const args = script(
			'ok.js',
			`console.error('  ⎔ Establishing remote connection...');
			console.log('SHARED ' + ${JSON.stringify(JSON.stringify(STAGE))});
			process.on('SIGTERM', () => process.exit(0));
			setInterval(() => {}, 1000);`
		);
		const { lines, held } = hold(args);
		const r = (await held) as HeldStage;
		expect('error' in r).toBe(false);
		expect(r.shared).toEqual(STAGE);
		expect(JSON.parse(r.env)).toEqual(STAGE);
		expect(lines).toContain('  ⎔ Establishing remote connection...');
		expect(alive(r.holderPid)).toBe(true);
		await r.dispose();
		expect(await gone(r.holderPid)).toBe(true);
	});

	test("the grandchild doesn't outlive the dispose", async () => {
		const args = script(
			'grand.js',
			`const { spawn } = require('node:child_process');
			const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
			console.log('SHARED ' + JSON.stringify({ ...${JSON.stringify(STAGE)}, pid: g.pid }));
			process.on('SIGTERM', () => process.exit(0));
			setInterval(() => {}, 1000);`
		);
		const r = (await hold(args).held) as HeldStage;
		const grandchild = r.shared.pid;
		expect(alive(grandchild)).toBe(true);
		await r.dispose();
		expect(await gone(grandchild)).toBe(true);
	});

	test('a holder that fails: its ✗ line is the error', async () => {
		const args = script('fail.js', `console.error('✗ couldn\\'t find a Cloudflare account'); process.exit(1);`);
		const r = await hold(args).held;
		expect(r).toEqual({ error: "it exited (1): couldn't find a Cloudflare account" });
	});

	test('a holder that hangs: given up after the timeout, and ended', async () => {
		const pidFile = join(dir, 'hang.pid');
		const args = script(
			'hang.js',
			`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`
		);
		const started = Date.now();
		const r = await hold(args, { timeoutMs: 400 }).held;
		expect(r).toEqual({ error: "it didn't open in 0 s" });
		expect(Date.now() - started).toBeLessThan(3000);
		expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
	});

	test('a stop while it opens ends the wait at once and the holder with it', async () => {
		const pidFile = join(dir, 'slow.pid');
		const args = script(
			'slow.js',
			`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.error('opening'); setInterval(() => {}, 1000);`
		);
		let stop = false;
		const { lines, held } = hold(args, { stopping: () => stop });
		while (!lines.includes('opening')) await new Promise((r) => setTimeout(r, 20));
		stop = true;
		const started = Date.now();
		expect(await held).toEqual({ error: 'the update was asked to stop' });
		expect(Date.now() - started).toBeLessThan(1000);
		expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
	});
});
