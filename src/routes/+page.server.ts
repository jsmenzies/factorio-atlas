import { env } from 'cloudflare:workers';
import { retryBusy } from '#lib/server/admin/busy.js';
import { PAGE_SIZE, parseSearch, searchPrints } from '#lib/server/queries.js';
import { iconSet } from '#lib/server/icon-set.js';
import { searchPicker } from '#lib/server/picker-items.js';
import type { PageServerLoad } from './$types';

/** One page of results with its facets. The picker and its icons come with the layout (+layout.server.ts), joined in +page.ts. */
export const load: PageServerLoad = async ({ url }) => {
	const params = parseSearch(url);
	// One batch; locally a render or backfill run can hold the database's lock for a moment (busy.ts).
	const found = await retryBusy(() => searchPrints(env.DB, params));

	// Results' outputs, facets, and filter chips (which can name anything), less those the picker's icons have.
	const all = iconSet(
		{
			item: params.module,
			recipe: params.recipe,
			signals: [
				...found.results.flatMap((r) => r.outputs),
				...found.facets.makes.map((f) => f.value),
				...found.facets.uses.map((f) => f.value),
				...params.makes,
				...params.takes,
				...params.uses
			]
		},
		found.results.map((r) => r.title)
	);
	const shared = searchPicker().icons.of;
	const icons = { base: all.base, of: Object.fromEntries(Object.entries(all.of).filter(([key]) => !(key in shared))) };
	// `?author=`: every result is theirs, so the first names them for the filter's chip.
	const authorName = params.author ? (found.results[0]?.author_name ?? null) : null;
	return { params, ...found, pageSize: PAGE_SIZE, icons, authorName };
};
