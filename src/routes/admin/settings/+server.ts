import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import type { RequestHandler } from './$types';

/** The settings moved into the Update tab (saved as they change there). Local only, like it. */
export const GET: RequestHandler = () => {
	if (!dev) error(404, 'Not found');
	redirect(308, '/admin/update');
};
