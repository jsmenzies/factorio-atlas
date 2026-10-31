/**
 * `render:flags` for one stage: which prints have a render (print_renders, the `render_yes` search
 * token) and each one's cover thumbnail, from what this machine uploaded to that stage's bucket
 * (scripts/render/flags.ts), written to the stage's D1 with syncRenderFlags. Shared by
 * `bun run render:flags` (scripts/render-flags.ts) and the `--flags` step that ends an upload run of
 * `bun run render` and `bun run render:thumbs`, which also asks for a page-cache bump when the run
 * changed what cached pages name (needsPageBump). It reads and writes nothing render input keys
 * depend on.
 */
import { bumpPageVersion } from '#lib/server/page-cache.js';
import { planSize, syncRenderFlags, type RenderCover } from '#lib/server/pipeline/render-flags.js';
import { loadRemovedPrintIds } from '#lib/server/removal-blocks.js';
import { openTarget, type Stage, type Target } from '../backfill/stage.js';
import { n, requireSchema } from '../stage-command.js';
import {
	coversFrom,
	diskPages,
	diskThumbs,
	localD1File,
	mergePages,
	readThumbUploads,
	readUploads,
	RENDERS_DIR,
	THUMBS_DIR,
	uploadedPages
} from './flags.js';

/** What an upload run changed that cached pages may name: replaced or removed pages, files scheduled for deletion. */
export interface PageChanges {
	/** Pages put at a new stamp over an older one in the bucket. */
	replaced: number;
	/** Pages taken out of the bucket's index (no longer rendered). */
	removed: number;
	/** Render files (overviews and the rest) and thumbnails put into render_deletes. */
	renderDeletes: number;
	thumbDeletes: number;
}

/**
 * Whether the stage's page cache must go (meta.sync_version): a cached print or render page names
 * overview, tile and thumbnail files from when it was made, and replaced ones are deleted after the
 * grace period. Pure.
 */
export const needsPageBump = (c: PageChanges) => c.replaced > 0 || c.removed > 0 || c.renderDeletes > 0 || c.thumbDeletes > 0;

/** The flags' inputs for `stage`, from the local D1 file (read-only) and, for local, the renders and thumbs folders. */
export async function flagInputs(
	stage: Stage
): Promise<{ wanted: Map<string, number>; covers: Map<string, RenderCover>; summary: string[] }> {
	const file = localD1File();
	if (!file) throw new Error('no local D1 database (.wrangler/state): run `bun run db:migrate`, and render with --upload first');
	const { jobs, uploads } = readUploads(file, stage);
	const thumbs = readThumbUploads(file, stage);
	const uploaded = uploadedPages(jobs, uploads);
	const disk = stage === 'local' ? await diskPages() : new Map<string, number>();
	const wanted = mergePages(uploaded, disk);
	// Search cards' cover thumbnails: the thumbnails uploaded to the stage's bucket (and, for local, the thumbs folder).
	const covers = coversFrom(stage === 'local' ? await diskThumbs() : new Map(), thumbs);
	return {
		wanted,
		covers,
		summary: [
			`${n(wanted.size)} prints have a render for ${stage}: ${n(uploaded.size)} uploaded to its bucket` +
				(stage === 'local' ? `, ${n(disk.size)} in ${RENDERS_DIR}` : ''),
			`${n([...wanted.keys()].filter((id) => covers.has(id)).length)} of them have a cover thumbnail: ${n(thumbs.size)} uploaded to the bucket` +
				(stage === 'local' ? `, ${n(covers.size)} with the thumbs folder (${THUMBS_DIR})` : '')
		]
	};
}

export interface StageFlagsOptions {
	generation?: number;
	dryRun?: boolean;
	/** Called before writing, with the question to put (render:flags asks for a typed "prod"; `--flags` is the consent). */
	confirm: (question: string) => Promise<void>;
	/** Bump the page cache even when no flag row changes (an upload run that replaced files). */
	bump?: boolean;
	log: (line: string) => void;
	/** A stage connection to use (and leave open) instead of opening one: the render run's own, locally. */
	target?: Target;
}

/**
 * Bring the stage's flags and cover thumbnails in line, over one stage connection, and bump the page
 * cache at most once: syncRenderFlags bumps when it writes rows, else `bump` does. Throws on failure.
 */
export async function runStageFlags(stage: Stage, opts: StageFlagsOptions): Promise<{ rowsWritten: number; bumped: boolean }> {
	const { wanted, covers, summary } = await flagInputs(stage);
	for (const line of summary) opts.log(line);
	// openTarget checks the stage has print_renders (migration 0015); the cover columns are 0018's. It
	// throws rather than exits, so an upload run's `--flags` step can fail without ending the run.
	const target = opts.target ?? (await openTarget(stage, { generation: opts.generation, log: opts.log }));
	try {
		const db = target.env.DB;
		await requireSchema(db, stage, 'SELECT cover_stamp FROM print_renders LIMIT 0', "print_renders' cover columns", '0018');
		// A print removed on request is never flagged, even while this machine still has its render rows.
		for (const id of await loadRemovedPrintIds(db)) {
			wanted.delete(id);
			covers.delete(id);
		}
		const preview = await syncRenderFlags(db, wanted, { dryRun: true, covers });
		const p = preview.plan;
		opts.log(
			`${target.database}: ${n(p.upsert.length)} rows to set, ${n(p.remove.length)} to unset, ${n(p.cover.length)} cover thumbnails to set or clear; ` +
				`search tokens: ${n(p.tag.length)} to add, ${n(p.untag.length)} to remove ` +
				`(${n(preview.searchable)} of the ${n(preview.flagged)} flagged prints are ingested here)`
		);
		const changes = planSize(p) > 0;
		if (opts.dryRun) {
			opts.log(`dry run; nothing written${opts.bump ? ' (the page cache would be bumped)' : ''}`);
			return { rowsWritten: 0, bumped: false };
		}
		if (!changes && !opts.bump) {
			opts.log('already in sync; nothing written');
			return { rowsWritten: 0, bumped: false };
		}
		await opts.confirm(changes ? 'Write these to PROD?' : 'Bump the PROD page cache?');
		let rowsWritten = 0;
		if (changes) {
			const done = await syncRenderFlags(db, wanted, { covers });
			rowsWritten = done.rowsWritten;
			opts.log(`✓ ${n(done.flagged)} prints flagged (${n(done.searchable)} searchable); ${n(done.rowsWritten)} D1 rows written`);
		}
		// syncRenderFlags bumped already when it wrote rows.
		let bumped = rowsWritten > 0;
		if (!bumped && opts.bump) {
			await bumpPageVersion(db).run();
			bumped = true;
			opts.log('✓ page cache bumped');
		}
		return { rowsWritten, bumped };
	} finally {
		if (!opts.target) await target.dispose();
	}
}
