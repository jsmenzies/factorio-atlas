/**
 * The update's one connection to a remote stage: scripts/backfill/hold-stage.ts run as a process of its own, in
 * its own process group (a Ctrl-C at the terminal reaches the step, not it), whose `SHARED <json>` line is
 * SHARED_STAGE_ENV for the steps. The update's process only waits on it, so its heartbeat and Stop keep
 * working while wrangler's checks and the sidecar start (≈ 10 s, at worst minutes): a stop or OPEN_TIMEOUT_MS
 * ends the wait, and the steps then open their own, as when run alone.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { SHARED_STAGE_ENV, type SharedStage } from '../backfill/stage';

/** wrangler's three checks plus the sidecar's 90 s start, with room to spare. */
export const OPEN_TIMEOUT_MS = 180_000;
/** How long the holder gets to close its sidecar (which itself waits up to 8 s) before its group is killed. */
export const CLOSE_GRACE_MS = 15_000;

export interface HeldStage {
	/** SHARED_STAGE_ENV's value. */
	env: string;
	shared: SharedStage;
	holderPid: number;
	/** Ends the holder (it closes the sidecar), then kills its process group, so nothing it started outlives it. */
	dispose: () => Promise<void>;
}

export interface HoldOptions {
	stage: string;
	cwd: string;
	log: (line: string) => void;
	/** Polled while waiting: true ends the wait (the update was asked to stop). */
	stopping: () => boolean;
	exec?: string;
	/** The holder's arguments (tests); default `scripts/backfill/hold-stage.ts <stage>`. */
	args?: string[];
	timeoutMs?: number;
	closeGraceMs?: number;
}

const killGroup = (pid: number, signal: NodeJS.Signals) => {
	try {
		process.kill(-pid, signal);
	} catch {
		// Already gone.
	}
};

/** Start the holder and wait for its stage: the held stage, or why there is none (it is ended then). */
export const holdSharedStage = (o: HoldOptions): Promise<HeldStage | { error: string }> => {
	const env = { ...process.env };
	delete env[SHARED_STAGE_ENV];
	const child = spawn(o.exec ?? process.execPath, o.args ?? ['scripts/backfill/hold-stage.ts', o.stage], {
		cwd: o.cwd,
		detached: true,
		stdio: ['pipe', 'pipe', 'pipe'],
		env
	});
	const pid = child.pid;
	let last = '';
	// Read both for the holder's whole life, so a full pipe never blocks it.
	createInterface({ input: child.stderr! }).on('line', (line) => {
		if (line.trim()) last = line;
		o.log(line);
	});
	const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
	const dispose = async () => {
		if (pid === undefined) return;
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, o.closeGraceMs ?? CLOSE_GRACE_MS))]);
		}
		killGroup(pid, 'SIGKILL');
	};
	return new Promise((resolve) => {
		let settled = false;
		const settle = (r: HeldStage | { error: string }) => {
			if (settled) return;
			settled = true;
			clearInterval(poll);
			clearTimeout(timer);
			resolve(r);
		};
		const giveUp = (error: string) => {
			if (settled) return;
			if (pid !== undefined) killGroup(pid, 'SIGKILL');
			settle({ error });
		};
		const poll = setInterval(() => {
			if (o.stopping()) giveUp('the update was asked to stop');
		}, 250);
		const timer = setTimeout(
			() => giveUp(`it didn't open in ${Math.round((o.timeoutMs ?? OPEN_TIMEOUT_MS) / 1000)} s`),
			o.timeoutMs ?? OPEN_TIMEOUT_MS
		);
		child.once('error', (e) => giveUp(e.message));
		child.once('exit', (code, signal) => giveUp(`it exited (${code ?? signal})${last ? `: ${last.replace(/^✗ /, '')}` : ''}`));
		createInterface({ input: child.stdout! }).on('line', (line) => {
			if (!line.startsWith('SHARED ') || settled) return;
			try {
				const shared = JSON.parse(line.slice('SHARED '.length)) as SharedStage;
				settle({ env: line.slice('SHARED '.length), shared, holderPid: pid!, dispose });
			} catch {
				giveUp(`it printed an unreadable stage: ${line.slice(0, 80)}`);
			}
		});
	});
};
