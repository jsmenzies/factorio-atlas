import { sectionOf } from '#lib/picker.js';
import { iconSet } from '#lib/server/icon-set.js';
import { renderDescription } from '#lib/server/markdown.js';
import { gameData } from '#lib/server/pipeline/game-data.js';
import { loadPrintDoc, printTexts } from '#lib/server/print-pages.js';
import { renderBase, renderOverviews } from '#lib/server/renders.js';
import type { PageServerLoad } from './$types';

/**
 * The print, its analysis and which pages have a game render. The viewer's data is fetched by
 * the page itself (`/prints/[id]/viewer`), so `?page=` changes don't re-run this load.
 */
export const load: PageServerLoad = async ({ params }) => {
	// The print page reads only R2 (its document and render index), never D1.
	const [found, overviews] = await loadPrintDoc(params.id, renderOverviews(params.id));
	const rendered = Object.keys(overviews);
	const a = found.analysis;
	// The header's background when the author has no screenshot: the rendered page with the most
	// entities, as a print's first page is often a small header or a thin strip of track.
	const biggest = a.nodes.filter((n) => n.path in overviews).sort((x, y) => y.entityCount - x.entityCount)[0];
	const cover = biggest ? { path: biggest.path, url: `${renderBase(params.id)}/${overviews[biggest.path]}` } : null;
	const icons = iconSet(
		{
			recipe: Object.keys(a.recipes),
			entity: Object.keys(a.entities),
			item: Object.keys(a.modules).map((m) => m.split('@')[0]),
			tile: Object.keys(a.tiles),
			// Badges on the sidebar's entities and modules above normal quality.
			quality: Object.keys(a.qualities),
			// Rates, page icons, and what each page makes and takes.
			signals: [...Object.keys(a.rates), ...a.nodes.flatMap((n) => [...n.icons, ...n.outputs, ...n.products, ...n.inputs])]
		},
		printTexts(found)
	);
	// Crafting-menu section per item a page makes, for grouping what isn't a main product.
	const sections = Object.fromEntries(
		[...new Set(a.nodes.flatMap((n) => [...n.outputs, ...n.products]))].map((signal) => {
			const name = signal.slice(signal.indexOf(':') + 1);
			const section = sectionOf(name, gameData.itemInfo[name]?.group ?? '') ?? (signal.startsWith('fluid:') ? 'Fluids' : 'Other');
			return [signal, section];
		})
	);
	// Untrusted Markdown from factorioprints.com users, sanitised here so the page can use {@html}. The
	// Markdown itself stays here: the page needs only the HTML, and whether to fold a long one.
	const { description_md, ...print } = found.print;
	const markdown = String(description_md ?? '');
	const descriptionHtml = renderDescription(markdown);
	return { ...found, print, icons, sections, descriptionHtml, descriptionLong: markdown.length > 900, rendered, cover };
};
