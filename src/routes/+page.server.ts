import { env } from 'cloudflare:workers';
import { retryBusy } from '#lib/server/admin/busy.js';
import { PAGE_SIZE, parseSearch, searchPrints } from '#lib/server/queries.js';
import { iconSet } from '#lib/server/icon-set.js';
import { pickerItems } from '#lib/server/picker-items.js';
import { TABS } from '#lib/picker.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const params = parseSearch(url);
	// One batch; locally a render or backfill run can hold the database's lock for a moment (busy.ts).
	const found = await retryBusy(() => searchPrints(env.DB, params));
	const makes = Object.fromEntries(found.facets.makes.map((f) => [f.value, f.n]));
	const uses = Object.fromEntries(found.facets.uses.map((f) => [f.value, f.n]));

	const picker = pickerItems(makes, uses);

	// The picker's items and tabs, results' outputs, facets, and filter chips (which can name anything).
	const icons = iconSet(
		{
			item: [...TABS.map((t) => t.icon), ...params.module],
			recipe: params.recipe,
			signals: [
				...picker.map((p) => p.signal),
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
	// `?author=`: every result is theirs, so the first names them for the filter's chip.
	const authorName = params.author ? (found.results[0]?.author_name ?? null) : null;
	return { params, ...found, pageSize: PAGE_SIZE, icons, picker, authorName };
};
