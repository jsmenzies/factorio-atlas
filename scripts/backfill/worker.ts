/**
 * A compute worker for `bun run backfill`: `planIngest` (sanitise, fingerprint, decode, analyse, build
 * viewer files and the R2 document) for one record at a time. Synchronous CPU work, up to ~1 s and
 * 120 MB for the largest print, so it runs here, where the parent can `terminate()` a stuck print.
 * It never touches D1 or R2.
 */
import { Effect } from 'effect';
import { planIngest } from '#lib/server/pipeline/pipeline.js';
import type { ComputeRequest, ComputeResponse } from './protocol';

declare const self: Worker;

const post = (message: ComputeResponse) => self.postMessage(message);

const reasonOf = (e: { _tag: string; op?: string; cause?: unknown }) => {
	const cause = e.cause instanceof Error ? e.cause.message : String(e.cause);
	return e._tag === 'RecordParseError' ? `parse: record is not JSON (${cause})` : `viewer: ${e.op ?? e._tag}: ${cause}`;
};

self.onmessage = async (event: MessageEvent<ComputeRequest>) => {
	const { job, id, text, sourceUrl, state, options } = event.data;
	const t0 = performance.now();
	try {
		const result = await Effect.runPromise(Effect.result(planIngest(id, text, sourceUrl, state, options)));
		const ms = performance.now() - t0;
		post(
			result._tag === 'Success'
				? { type: 'done', job, ms, plan: result.success }
				: { type: 'error', job, ms, reason: reasonOf(result.failure) }
		);
	} catch (e) {
		post({ type: 'error', job, ms: performance.now() - t0, reason: `worker: ${e instanceof Error ? e.message : String(e)}` });
	}
};

post({ type: 'ready' });
