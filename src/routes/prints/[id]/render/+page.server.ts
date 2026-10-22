import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { describeNode, describeSetup, pageTitle } from '#lib/describe.js';
import { iconSet } from '#lib/server/icon-set.js';
import { readPrintDoc } from '#lib/server/pipeline/print-doc.js';
import { loadViewerPage } from '#lib/server/print-pages.js';
import { renderBase } from '#lib/server/renders.js';
import type { PageServerLoad } from './$types';

/**
 * One book page's game render, with its entity data (made with the render) for hover tooltips.
 * `?page=3/1` picks the page by book path (matches `print_nodes.path`). The header comes from the
 * analysis document, so it shows whether or not the page has a render.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	const doc = await readPrintDoc(env.RAW, params.id);
	if (!doc) error(404, 'Print not found');
	const row = doc.print;

	const found = await loadViewerPage(params.id, url.searchParams.get('page'));
	if (!found) error(404, 'No viewer files');
	const { pages, path, page, render, tooltip } = found;
	// What the analyzer says about each page, keyed by book path, for the page picker and header.
	const nodes = doc.analysis.nodes;
	const info = Object.fromEntries(
		nodes.map((n) => [
			n.path,
			{
				title: pageTitle(n),
				summary: n.kind === 'blueprint' ? describeNode(n, { withRate: true }) : null,
				setup: n.kind === 'blueprint' && n.role === 'production' ? describeSetup(n) : '',
				icons: n.icons,
				kind: n.kind,
				label: n.label,
				entities: n.kind === 'blueprint' ? n.entityCount : null,
				gameVersion: n.gameVersion,
				size: n.width && n.height ? `${n.width}×${n.height}` : null
			}
		])
	);
	const icons = iconSet({ signals: nodes.flatMap((n) => n.icons) }, [row.title, ...nodes.map((n) => n.label)]);
	const print = { id: row.id, title: row.title, author_name: row.author_name, image_id: row.image_id, image_type: row.image_type };
	return { print, pages, path, page, info, icons, render, base: renderBase(params.id), tooltip };
};
