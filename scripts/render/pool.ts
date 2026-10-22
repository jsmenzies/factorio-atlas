/**
 * A pool of render worker processes (scripts/render/worker.ts). Each renders one page at a time
 * under a timeout and a memory cap (its footprint, polled from /proc: anonymous memory plus shared
 * memory, memfd files included; see memory.ts); a worker that crashes, hangs or grows past the cap
 * is killed, fails only its page and is replaced. A worker the kernel's OOM killer took (SIGKILL
 * that the pool didn't send, with /proc/vmstat's oom_kill count up) is reported as 'oom' and to
 * `onOom`. Workers that end a page above the recycle size are restarted between pages, since
 * native canvas memory grows and is not given back.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PageJob, PageResult } from './draw.js';
import { footprintMb, oomKills } from './memory.js';
import type { FromWorker, ToWorker, WorkerInit } from './protocol.js';

const WORKER = join(import.meta.dirname, 'worker.ts');
const STARTUP_MS = 120_000;
const POLL_MS = 1_000;

export type Outcome =
	| { ok: true; result: PageResult; peakMb: number }
	| { ok: false; kind: 'error' | 'timeout' | 'crash' | 'memory' | 'oom'; error: string; peakMb: number };

interface Slot {
	n: number;
	proc: ChildProcess;
	ready: boolean;
	/** Asked to exit to make way for a fresh worker. */
	retired: boolean;
	exited: boolean;
	/** The pool sent it SIGKILL (timeout, memory cap, no exit after retiring). */
	killed: boolean;
	stderr: string;
	peakMb: number;
	/** Its footprint at the last poll or page end. */
	memMb: number;
	current: { resolve: (o: Outcome) => void; timer: NodeJS.Timeout; killedFor?: 'timeout' | 'memory'; error?: string } | null;
}

export interface PoolOptions {
	size: number;
	init: WorkerInit;
	/** Kill a worker whose resident set passes this mid-page. */
	memCapMb: number;
	/** Restart a worker between pages once it has grown past this. */
	recycleMb: number;
	log: (line: string) => void;
	/** A worker was killed by the kernel's OOM killer (busy or idle). */
	onOom?: () => void;
}

export function createPool(opts: PoolOptions) {
	const slots: Slot[] = [];
	const waiters: { resolve: (s: Slot) => void; reject: (e: Error) => void }[] = [];
	let closing = false;
	/** Set when workers keep dying before they are ready (bad assets, a broken install): the run can't go on. */
	let broken: Error | null = null;
	let startupFailures = 0;
	let spawned = 0;
	/** Highest footprint any worker reached, for the run summary. */
	let peakMb = 0;
	/** The kernel's OOM kill count, less those not yet put down to a worker. */
	let oomAttributed = oomKills() ?? 0;
	let oomKilled = 0;

	const finish = (slot: Slot, o: Outcome) => {
		const cur = slot.current;
		if (!cur) return;
		clearTimeout(cur.timer);
		slot.current = null;
		cur.resolve(o);
	};

	const release = (slot: Slot) => {
		if (slot.exited || !slot.ready || slot.current || closing) return;
		waiters.shift()?.resolve(slot);
	};

	function spawn(): Slot {
		const n = ++spawned;
		const proc = fork(WORKER, [], {
			execPath: process.execPath,
			env: { ...process.env, RENDER_WORKER: JSON.stringify(opts.init) },
			stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
			serialization: 'json'
		});
		const slot: Slot = {
			n,
			proc,
			ready: false,
			retired: false,
			exited: false,
			killed: false,
			stderr: '',
			peakMb: 0,
			memMb: 0,
			current: null
		};
		const startup = setTimeout(() => {
			opts.log(`worker ${n} did not start in ${STARTUP_MS / 1000} s; killing it`);
			kill(slot);
		}, STARTUP_MS);
		proc.stderr?.setEncoding('utf8');
		proc.stderr?.on('data', (text: string) => {
			slot.stderr = (slot.stderr + text).slice(-4096);
			process.stderr.write(text.replace(/^(?=.)/gm, `[worker ${n}] `));
		});
		proc.on('message', (message: FromWorker) => {
			if (message.type === 'ready') {
				slot.ready = true;
				startupFailures = 0;
				clearTimeout(startup);
				release(slot);
				return;
			}
			slot.memMb = message.memMb;
			slot.peakMb = Math.max(slot.peakMb, message.memMb);
			peakMb = Math.max(peakMb, message.memMb);
			const peak = slot.peakMb;
			if (message.type === 'done') finish(slot, { ok: true, result: message.result, peakMb: peak });
			else finish(slot, { ok: false, kind: 'error', error: message.message, peakMb: peak });
			if (message.memMb > opts.recycleMb && !closing) {
				opts.log(`worker ${slot.n} holds ${message.memMb} MB: restarting it`);
				replace(slot);
			} else release(slot);
		});
		proc.on('error', (e) => opts.log(`worker ${n}: ${e.message}`));
		proc.on('exit', (code, signal) => {
			slot.exited = true;
			clearTimeout(startup);
			// SIGKILL the pool didn't send, with the kernel's OOM kill count up: the OOM killer took it.
			let oom = false;
			if (signal === 'SIGKILL' && !slot.killed) {
				const kills = oomKills();
				if (kills !== null && kills > oomAttributed) {
					oomAttributed++;
					oomKilled++;
					oom = true;
					opts.log(`worker ${n} was killed by the kernel's OOM killer (${slot.memMb} MB at the last poll)`);
					opts.onOom?.();
				}
			}
			const cur = slot.current;
			if (cur) {
				const tail = slot.stderr.trim().split('\n').slice(-5).join(' | ');
				const why = cur.killedFor
					? cur.error!
					: oom
						? 'worker killed by the kernel: out of memory'
						: `worker crashed (${signal ?? `exit ${code}`})${tail ? `: ${tail}` : ''}`;
				finish(slot, { ok: false, kind: cur.killedFor ?? (oom ? 'oom' : 'crash'), error: why, peakMb: slot.peakMb });
			}
			const i = slots.indexOf(slot);
			if (i >= 0) slots.splice(i, 1);
			if (closing || broken) return;
			// One the OOM killer took while starting says nothing about the install.
			if (!slot.ready && !slot.retired && !oom) {
				const why = `worker ${n} exited during startup (${signal ?? `exit ${code}`}): ${slot.stderr.trim().slice(-500)}`;
				opts.log(why);
				if (++startupFailures >= 3) {
					broken = new Error(`render workers keep failing to start; last: ${why}`);
					for (const w of waiters.splice(0)) w.reject(broken);
					return;
				}
			}
			slots.push(spawn());
		});
		return slot;
	}

	function replace(slot: Slot) {
		// The exit handler spawns the successor.
		slot.ready = false;
		slot.retired = true;
		send(slot, { type: 'exit' });
		setTimeout(() => slot.exited || kill(slot), 10_000).unref();
	}

	function kill(slot: Slot) {
		slot.killed = true;
		slot.proc.kill('SIGKILL');
	}

	/** False when the channel is gone (the worker is exiting); the exit handler deals with it. */
	const send = (slot: Slot, m: ToWorker) => {
		try {
			return slot.proc.connected && slot.proc.send(m);
		} catch {
			return false;
		}
	};

	const poll = setInterval(async () => {
		for (const slot of slots) {
			if (slot.exited || !slot.proc.pid) continue;
			const mb = await footprintMb(slot.proc.pid);
			if (mb === null || slot.exited) continue;
			slot.memMb = mb;
			slot.peakMb = Math.max(slot.peakMb, mb);
			peakMb = Math.max(peakMb, mb);
			if (slot.current && !slot.current.killedFor && mb > opts.memCapMb) {
				slot.current.killedFor = 'memory';
				slot.current.error = `worker passed the memory cap (${mb} MB > ${opts.memCapMb} MB)`;
				kill(slot);
			}
		}
	}, POLL_MS);

	for (let i = 0; i < opts.size; i++) slots.push(spawn());

	return {
		get peakMb() {
			return peakMb;
		},
		/** Workers the kernel's OOM killer took. */
		get oomKilled() {
			return oomKilled;
		},
		/** What each live worker holds (MB, at the last poll or page end) and whether it has a page. */
		memory: () => slots.filter((s) => !s.exited).map((s) => ({ slot: s, memMb: s.memMb, busy: s.current !== null })),
		/** Tell every worker how many AVIF encodes to keep in flight (new workers start from `init`). */
		setEncodeParallel(n: number) {
			opts.init.encodeParallel = n;
			for (const s of slots) if (s.ready) send(s, { type: 'parallel', encodes: n });
		},
		/** Wait for an idle worker. One caller at a time, and it must `run` the slot before asking again. */
		acquire(): Promise<Slot> {
			if (broken) return Promise.reject(broken);
			const idle = slots.find((s) => s.ready && !s.exited && !s.current);
			if (idle) return Promise.resolve(idle);
			return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
		},
		/** Render one page on an idle worker from `acquire`. */
		run(slot: Slot, job: PageJob, timeoutMs: number): Promise<Outcome> {
			return new Promise((resolve) => {
				slot.peakMb = 0;
				const timer = setTimeout(() => {
					if (!slot.current) return;
					slot.current.killedFor = 'timeout';
					slot.current.error = `timed out after ${Math.round(timeoutMs / 1000)} s`;
					kill(slot);
				}, timeoutMs);
				slot.current = { resolve, timer };
				if (!send(slot, { type: 'render', job })) {
					// The exit handler resolves the page as crashed.
					kill(slot);
				}
			});
		},
		/** Stop every worker: politely, then SIGKILL after `graceMs`. In-flight pages resolve as crashed. */
		async close(graceMs = 5_000) {
			closing = true;
			clearInterval(poll);
			const all = [...slots];
			for (const s of all) if (!send(s, { type: 'exit' })) kill(s);
			const deadline = Date.now() + graceMs;
			while (all.some((s) => !s.exited) && Date.now() < deadline) await sleep(50);
			for (const s of all) if (!s.exited) kill(s);
			while (all.some((s) => !s.exited)) await sleep(20);
		}
	};
}

export type Pool = ReturnType<typeof createPool>;
export type { Slot };
