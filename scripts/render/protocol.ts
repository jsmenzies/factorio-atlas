/** Messages between the render runner and its worker processes (child_process IPC, JSON). */
import type { PageJob, PageResult } from './draw.js';

export interface WorkerInit {
	/** AVIF encodes in flight per worker at the start (the runner adjusts it), and libvips threads per encode. */
	encodeParallel: number;
	encodeThreads: number;
	outDir: string;
}

export type ToWorker = { type: 'render'; job: PageJob } | { type: 'parallel'; encodes: number } | { type: 'exit' };

/** `memMb`: the worker's footprint after the page (memory.ts `footprintMb`: anonymous memory plus shared memory and memfd files). */
export type FromWorker =
	| { type: 'ready' }
	| { type: 'done'; result: PageResult; memMb: number }
	| { type: 'error'; message: string; memMb: number };
