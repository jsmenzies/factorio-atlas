import { searchPicker } from '#lib/server/picker-items.js';
import type { LayoutServerLoad } from './$types';

/**
 * The search page's picker (about 75 KB with its icons), the same for every search. Loaded here, and
 * only on the search page, so it depends on the route alone: moving from one search to another
 * doesn't fetch it again, only arriving at the search from another page does.
 */
export const load: LayoutServerLoad = ({ route }) => ({ searchPicker: route.id === '/' ? searchPicker() : null });
