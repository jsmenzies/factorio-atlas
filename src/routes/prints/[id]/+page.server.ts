import { sectionOf } from '#lib/picker.js';
import { iconSet } from '#lib/server/icon-set.js';
import { renderDescription } from '#lib/server/markdown.js';
import { gameData } from '#lib/server/pipeline/game-data.js';
import { loadPrintDoc, printTexts } from '#lib/server/print-pages.js';
import { renderedPages } from '#lib/server/renders.js';
import type { PageServerLoad } from './$types';

/**
 * The print, its analysis and which pages have a game render. The viewer's data is fetched by
 * the page itself (`/prints/[id]/viewer`), so `?page=` changes don't re-run this load.
 */
export const load: PageServerLoad = async ({ params }) => {
	// The print page reads only R2 (its document and render index), never D1.
	const [found, rendered] = await loadPrintDoc(params.id, renderedPages(params.id));
	const a = found.analysis;
	const icons = iconSet(
		{
			recipe: Object.keys(a.recipes),
			entity: Object.keys(a.entities),
			item: Object.keys(a.modules).map((m) => m.split('@')[0]),
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
	return { ...found, print, icons, sections, descriptionHtml, descriptionLong: markdown.length > 900, rendered };
};
