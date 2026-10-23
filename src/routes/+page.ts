import { withCounts } from '#lib/picker.js';
import type { PageLoad } from './$types';

/** The layout's picker with this search's counts, and one icon set: the picker's icons with this page's own. */
export const load: PageLoad = async ({ data, parent }) => {
	const { searchPicker } = await parent();
	return {
		...data,
		picker: withCounts(searchPicker?.items ?? [], data.facets.makes, data.facets.uses),
		icons: { base: data.icons.base, of: { ...searchPicker?.icons.of, ...data.icons.of } }
	};
};
