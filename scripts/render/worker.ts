/**
 * One render worker process, started by scripts/render-game.ts. Loads the fpsr renderer once,
 * then renders the pages it is sent, one at a time, and reports each result over IPC. Settings
 * come in RENDER_WORKER (JSON, see WorkerInit). A page that throws is reported and the worker
 * carries on; one that crashes or hangs the process is the runner's to handle. Each worker makes
 * itself the OOM killer's first choice, so under memory pressure the kernel kills a worker (its page
 * is retried) rather than the runner or the user's session.
 */
import sharp from 'sharp';
import { createPageRenderer } from './draw.js';
import { footprintMb, preferOomKill } from './memory.js';
import type { FromWorker, ToWorker, WorkerInit } from './protocol.js';
import { loadAssetInfo } from './settings.js';

if (!preferOomKill() && process.platform === 'linux') console.error('could not raise oom_score_adj; the OOM killer may pick the runner');

const init = JSON.parse(process.env.RENDER_WORKER ?? '{}') as WorkerInit;
const send = (m: FromWorker) => process.send!(m);
const memMb = async () => (await footprintMb('self')) ?? Math.round(process.memoryUsage.rss() / 1048576);
const collect = () => (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);

sharp.concurrency(init.encodeThreads);
sharp.cache(false);

const assets = await loadAssetInfo();
if (typeof assets === 'string') {
	console.error(assets);
	process.exit(1);
}
const renderer = await createPageRenderer(assets, { outDir: init.outDir, encodeParallel: init.encodeParallel });

let busy = Promise.resolve();
// Canvases hold native memory the JS heap doesn't see: collect after each page, before measuring
// what the worker holds (the runner restarts it past --recycle-mb).
process.on('message', (m: ToWorker) => {
	if (m.type === 'exit') process.exit(0);
	if (m.type === 'parallel') return renderer.setEncodeParallel(m.encodes);
	busy = busy.then(async () => {
		try {
			const result = await renderer.render(m.job);
			collect();
			send({ type: 'done', result, memMb: await memMb() });
		} catch (e) {
			collect();
			send({ type: 'error', message: e instanceof Error ? (e.stack ?? e.message) : String(e), memMb: await memMb() });
		}
	});
});
// The runner going away (killed, crashed) closes the channel: nothing left to work for. Bun doesn't
// always report a dead parent's channel, so also watch for being reparented.
process.on('disconnect', () => process.exit(0));
const parent = process.ppid;
setInterval(() => {
	if (process.ppid !== parent || !process.connected) process.exit(0);
}, 1_000).unref();
// Ctrl-C reaches the whole process group; the runner decides when workers stop.
process.on('SIGINT', () => {});

send({ type: 'ready' });
