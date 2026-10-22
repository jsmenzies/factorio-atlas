/**
 * A small pool of Bun Workers running `planIngest`, with a per-print timeout. Analysis is synchronous,
 * so a stuck print can't be interrupted from inside; on timeout the parent `terminate()`s the worker
 * (checked: that stops a busy synchronous loop within milliseconds) and starts a fresh one.
 */
import type { IngestPlan } from '#lib/server/pipeline/pipeline.js';
import type { ComputeRequest, ComputeResponse } from './protocol';

export class ComputeTimeout extends Error {
	constructor(readonly ms: number) {
		super(`over ${ms / 1000} s`);
	}
}

/** A worker died (crash or terminate) while computing; not the print's fault as far as we know. */
export class ComputeCrash extends Error {}

export interface ComputeResult {
	readonly ok: boolean;
	readonly plan?: IngestPlan;
	readonly reason?: string;
	readonly ms: number;
}

interface Job {
	readonly request: Omit<ComputeRequest, 'job'>;
	readonly resolve: (r: ComputeResult) => void;
	readonly reject: (e: Error) => void;
}

interface Slot {
	worker: Worker;
	ready: boolean;
	job: { id: number; job: Job; timer: ReturnType<typeof setTimeout> } | null;
}

const WORKER_URL = new URL('./worker.ts', import.meta.url).href;

export class ComputePool {
	private readonly slots: Slot[] = [];
	private readonly queue: Job[] = [];
	private nextJob = 1;
	private closed = false;

	constructor(
		size: number,
		private readonly timeoutMs: number
	) {
		for (let i = 0; i < size; i++) {
			const slot = { ready: false, job: null } as unknown as Slot;
			this.start(slot);
			this.slots.push(slot);
		}
	}

	run(request: Omit<ComputeRequest, 'job'>): Promise<ComputeResult> {
		if (this.closed) return Promise.reject(new ComputeCrash('pool closed'));
		return new Promise((resolve, reject) => {
			this.queue.push({ request, resolve, reject });
			this.pump();
		});
	}

	/** Kill every worker now; pending and running jobs reject. */
	close() {
		this.closed = true;
		for (const slot of this.slots) {
			slot.worker.terminate();
			if (slot.job) {
				clearTimeout(slot.job.timer);
				slot.job.job.reject(new ComputeCrash('pool closed'));
				slot.job = null;
			}
		}
		for (const job of this.queue.splice(0)) job.reject(new ComputeCrash('pool closed'));
	}

	/** Give the slot a fresh worker; it takes work once it says it's ready. */
	private start(slot: Slot) {
		const worker = new Worker(WORKER_URL);
		worker.onmessage = (event: MessageEvent<ComputeResponse>) => this.onMessage(slot, event.data);
		worker.onerror = (event) => this.fail(slot, new ComputeCrash(`worker crashed: ${event.message}`));
		slot.worker = worker;
		slot.ready = false;
	}

	private onMessage(slot: Slot, message: ComputeResponse) {
		if (message.type === 'ready') {
			slot.ready = true;
		} else if (slot.job && slot.job.id === message.job) {
			clearTimeout(slot.job.timer);
			const { job } = slot.job;
			slot.job = null;
			job.resolve(
				message.type === 'done' ? { ok: true, plan: message.plan, ms: message.ms } : { ok: false, reason: message.reason, ms: message.ms }
			);
		}
		this.pump();
	}

	/** Replace the slot's worker and reject what it was doing. */
	private fail(slot: Slot, error: Error) {
		slot.worker.terminate();
		const running = slot.job;
		slot.job = null;
		if (!this.closed) this.start(slot);
		if (running) {
			clearTimeout(running.timer);
			running.job.reject(error);
		}
		this.pump();
	}

	private pump() {
		if (this.closed) return;
		for (const slot of this.slots) {
			if (!slot.ready || slot.job || this.queue.length === 0) continue;
			const job = this.queue.shift()!;
			const id = this.nextJob++;
			// The clock starts once a ready worker has the print, so worker start-up never counts.
			const timer = setTimeout(() => this.fail(slot, new ComputeTimeout(this.timeoutMs)), this.timeoutMs);
			slot.job = { id, job, timer };
			slot.worker.postMessage({ ...job.request, job: id } satisfies ComputeRequest);
		}
	}
}
