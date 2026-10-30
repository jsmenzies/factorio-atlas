import { env } from 'cloudflare:workers';
import { accountList, accountPage, accountSearch } from '#lib/server/admin/accounts.js';
import { retryBusy } from '#lib/server/admin/busy.js';
import type { PageServerLoad } from './$types';

/** Every site account, newest first, a page at a time (`?q=` name contains, `?p=` page); one D1 batch. */
export const load: PageServerLoad = async ({ url }) => {
	const q = accountSearch(url.searchParams.get('q'));
	const list = await retryBusy(() => accountList(env.DB, { q, page: accountPage(url.searchParams.get('p')) }));
	return { ...list, q, deleted: url.searchParams.get('deleted') };
};
