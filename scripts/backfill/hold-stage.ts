/**
 * `bun scripts/backfill/hold-stage.ts <stage>`: holds a remote stage open for an update (scripts/sync.ts
 * starts it, in its own process group, and ends it). Opens the stage as openTarget would (wrangler's checks,
 * then the Node sidecar), prints `SHARED <json>` (SHARED_STAGE_ENV's value) on stdout, and keeps the sidecar
 * until SIGTERM, SIGINT or its stdin closes (the update ended or died). Its own process, because wrangler's
 * checks block: in the update's process they would stall its heartbeat and its Stop. Progress and errors go
 * to stderr; exit 1 when the stage can't be opened.
 */
import { openSharedStage, STAGES, type Stage } from './stage';

const stage = process.argv[2] as Stage | undefined;
if (!stage || stage === 'local' || !STAGES.includes(stage)) {
	console.error(`usage: bun scripts/backfill/hold-stage.ts <${STAGES.filter((s) => s !== 'local').join('|')}>`);
	process.exit(2);
}

const shared = await openSharedStage(stage, { log: (line) => console.error(line) }).catch((e: unknown) => {
	console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
	return process.exit(1);
});

let closing = false;
const close = async () => {
	if (closing) return;
	closing = true;
	await shared.dispose();
	process.exit(0);
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void close());
process.stdin.on('end', () => void close());
process.stdin.on('close', () => void close());
process.stdin.resume();
console.log(`SHARED ${shared.env}`);
