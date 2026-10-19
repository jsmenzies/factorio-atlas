/** Messages between scripts/backfill.ts and its compute workers (scripts/backfill/worker.ts). */
import type { IngestOptions, IngestPlan } from '#lib/server/pipeline/pipeline.js';
import type { IngestState } from '#lib/server/pipeline/repository.js';

export interface ComputeRequest {
	readonly job: number;
	readonly id: string;
	readonly text: string;
	readonly sourceUrl: string;
	readonly state: IngestState | null;
	readonly options: IngestOptions;
}

export type ComputeResponse =
	| { readonly type: 'ready' }
	| { readonly type: 'done'; readonly job: number; readonly ms: number; readonly plan: IngestPlan }
	/** Not a print failure that `ingest_state` tracks (bad JSON, a viewer build that threw): counted, retried next run. */
	| { readonly type: 'error'; readonly job: number; readonly ms: number; readonly reason: string };
