/**
 * `kill -9` of the runner leaves the workerd that getPlatformProxy started running, idle. The runner
 * records its workerd processes in its run's options (`workerd`), and the next run on the host stops
 * those of runs whose runner is gone. Linux only (it reads /proc); elsewhere nothing is recorded.
 */
import { readdirSync, readFileSync } from 'node:fs';

const procStat = (pid: number): { comm: string; ppid: number } | null => {
	try {
		const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const close = s.lastIndexOf(')');
		return { comm: s.slice(s.indexOf('(') + 1, close), ppid: Number(s.slice(close + 2).split(' ')[1]) };
	} catch {
		return null;
	}
};

/** The workerd processes whose parent is `parent`. */
export function childWorkerd(parent: number): number[] {
	let entries: string[];
	try {
		entries = readdirSync('/proc');
	} catch {
		return [];
	}
	return entries
		.filter((d) => /^\d+$/.test(d))
		.map(Number)
		.filter((pid) => {
			const s = procStat(pid);
			return s?.comm === 'workerd' && s.ppid === parent;
		});
}

/**
 * Stop each of these recorded processes that is still a workerd and has lost its parent. One whose
 * parent is a node, bun or workerd process (a dev server's, the pid reused) is left alone. Returns
 * how many were stopped.
 */
export function stopOrphanedWorkerd(pids: number[]): number {
	let stopped = 0;
	for (const pid of pids) {
		const s = procStat(pid);
		if (s?.comm !== 'workerd') continue;
		const parent = procStat(s.ppid);
		if (parent && /node|bun|vite|workerd/i.test(parent.comm)) continue;
		try {
			process.kill(pid, 'SIGTERM');
			stopped++;
		} catch {
			// Gone already, or not ours.
		}
	}
	return stopped;
}
