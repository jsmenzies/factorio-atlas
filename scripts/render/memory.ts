/**
 * Memory for the render scheduler: what the machine has free (/proc/meminfo), what each worker
 * really holds (/proc/<pid>/status plus memfd files it keeps open), and whether a page may start.
 * Linux only for the readings; elsewhere they are null and the scheduler falls back to estimates.
 * The parsing and the admission decision are pure, for tests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { renderReserveMb } from '#lib/sync.js';

export interface MemInfo {
	totalMb: number;
	availableMb: number;
	shmemMb: number;
	swapFreeMb: number;
}

/** /proc/meminfo as MB, or null when MemTotal or MemAvailable is missing. */
export function parseMeminfo(text: string): MemInfo | null {
	const kb = (name: string) => {
		const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
		return m ? Number(m[1]) / 1024 : null;
	};
	const total = kb('MemTotal');
	const available = kb('MemAvailable');
	if (total === null || available === null) return null;
	return {
		totalMb: Math.round(total),
		availableMb: Math.round(available),
		shmemMb: Math.round(kb('Shmem') ?? 0),
		swapFreeMb: Math.round(kb('SwapFree') ?? 0)
	};
}

export async function readMeminfo(): Promise<MemInfo | null> {
	if (process.platform !== 'linux') return null;
	try {
		return parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
	} catch {
		return null;
	}
}

/** The kernel's count of OOM kills since boot (/proc/vmstat `oom_kill`), or null. */
export function oomKills(): number | null {
	if (process.platform !== 'linux') return null;
	try {
		const m = /^oom_kill (\d+)$/m.exec(readFileSync('/proc/vmstat', 'utf8'));
		return m ? Number(m[1]) : null;
	} catch {
		return null;
	}
}

/**
 * Make this process the OOM killer's first choice (oom_score_adj 1000; raising it needs no
 * privilege). A render worker does this, so the kernel kills a worker, never the runner or the
 * user's session. False where it can't (not Linux).
 */
export function preferOomKill(): boolean {
	if (process.platform !== 'linux') return false;
	try {
		writeFileSync('/proc/self/oom_score_adj', '1000');
		return true;
	} catch {
		return false;
	}
}

/**
 * Rough peak footprint of a fresh worker drawing a page: its anonymous memory plus the memfd
 * Mesa's llvmpipe keeps for the canvases (skia-canvas draws through Vulkan on the CPU). Measured:
 * 1.0 to 1.35 GB at 3k to 9k entities, 3.4 GB of RSS alone at 133k.
 */
export const memEstimateMb = (entities: number) => 1300 + entities * 0.02;

/**
 * What a page adds on top of what its worker already holds: chunk canvases, pixels and encodes.
 * Measured 170 to 270 MB at 5k to 9k entities on a worker that had its atlases loaded.
 */
export const pageGrowthMb = (entities: number) => 200 + entities * 0.02;

/**
 * Expected peak footprint of a worker that holds `workerMb` while it draws a page: a fresh worker
 * grows to `memEstimateMb`, a warm one (sprites and textures cached, which only grow) by `pageGrowthMb`.
 */
export const pagePeakMb = (entities: number, workerMb: number) => Math.max(memEstimateMb(entities), workerMb + pageGrowthMb(entities));

/** Memory kept free for everything else on the machine: the larger of 2 GB and 10% of RAM. */
export const defaultReserveMb = renderReserveMb;

/**
 * A process's own memory from /proc/<pid>/status: anonymous plus shared-memory pages it maps.
 * File pages (the program and its libraries) are shared and left out.
 */
export function parseStatus(text: string): { rssMb: number; anonMb: number; shmemMb: number } | null {
	const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? NaN);
	const rss = kb('VmRSS');
	if (!Number.isFinite(rss)) return null;
	const anon = kb('RssAnon');
	const shmem = kb('RssShmem');
	return {
		rssMb: rss / 1024,
		anonMb: Number.isFinite(anon) ? anon / 1024 : rss / 1024,
		shmemMb: Number.isFinite(shmem) ? shmem / 1024 : 0
	};
}

/**
 * What a process holds in MB: anonymous memory, plus its shared memory counted as the larger of
 * what it maps and the memfd files it keeps open. A memfd's pages stay in RAM (as Shmem) while
 * the file is open, mapped or not, so RSS alone undercounts them. Falls back to VmRSS when the
 * fds can't be read; null when the process is gone or this isn't Linux.
 */
export async function footprintMb(pid: number | 'self'): Promise<number | null> {
	if (process.platform !== 'linux') return null;
	let status;
	try {
		status = parseStatus(await readFile(`/proc/${pid}/status`, 'utf8'));
	} catch {
		return null;
	}
	if (!status) return null;
	let memfdMb = 0;
	try {
		const dir = `/proc/${pid}/fd`;
		for (const fd of await readdir(dir)) {
			try {
				if (!(await readlink(`${dir}/${fd}`)).startsWith('/memfd:')) continue;
				memfdMb += ((await stat(`${dir}/${fd}`)).blocks * 512) / 1048576;
			} catch {
				// Closed meanwhile.
			}
		}
	} catch {
		return Math.round(status.rssMb);
	}
	return Math.round(status.anonMb + Math.max(status.shmemMb, memfdMb));
}

/** A worker as the scheduler sees it: what it holds now, and its expected peak for the page it draws (null: idle). */
export interface WorkerMemory {
	footprintMb: number;
	peakMb: number | null;
}

export interface AdmissionInput {
	/** The page's expected peak on the worker that would draw it (`pagePeakMb`). */
	peakMb: number;
	/** What the idle worker that would draw it holds now. */
	workerMb: number;
	/** Every live worker, the idle one included. */
	workers: WorkerMemory[];
	/** Pages in flight. With none, a page always starts (no deadlock). */
	inFlight: number;
	/** The sum the workers may reach (--mem-budget-mb). */
	budgetMb: number;
	/** MemAvailable now, or null where it can't be read. */
	availableMb: number | null;
	/** Kept free beside the pages (--mem-reserve-mb). */
	reserveMb: number;
}

export type Admission =
	| { ok: true }
	| { ok: false; why: 'budget'; needMb: number; limitMb: number }
	| { ok: false; why: 'memory'; needMb: number; availableMb: number; reserveMb: number };

/**
 * Whether a page may start now. A page in flight may still grow to its expected peak, so each
 * counts for what it has left to grow; the new page counts for its peak less what its worker holds.
 * - budget: what the workers hold, or will once their pages peak, plus the new page's growth, fits
 *   in the budget;
 * - memory: MemAvailable, less what the pages in flight and the new one still have to grow, stays
 *   above the reserve.
 */
export function admit(i: AdmissionInput): Admission {
	if (i.inFlight === 0) return { ok: true };
	const growth = Math.max(0, i.peakMb - i.workerMb);
	let held = 0;
	let toGrow = 0;
	for (const w of i.workers) {
		const peak = w.peakMb === null ? w.footprintMb : Math.max(w.footprintMb, w.peakMb);
		held += peak;
		toGrow += peak - w.footprintMb;
	}
	const needBudget = held + growth;
	if (needBudget > i.budgetMb) return { ok: false, why: 'budget', needMb: Math.round(needBudget), limitMb: i.budgetMb };
	if (i.availableMb !== null) {
		const need = toGrow + growth;
		if (i.availableMb - need < i.reserveMb)
			return { ok: false, why: 'memory', needMb: Math.round(need), availableMb: i.availableMb, reserveMb: i.reserveMb };
	}
	return { ok: true };
}

/**
 * The most workers that fit: RAM less the reserve, over the least a worker holds while drawing
 * a small page. At least 1.
 */
export const maxWorkers = (ramMb: number, reserveMb: number, perWorkerMb: number) =>
	Math.max(1, Math.floor((ramMb - reserveMb) / perWorkerMb));
