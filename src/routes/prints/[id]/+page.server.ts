import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { sectionOf } from '#lib/picker.js';
import { iconSet, signalItems } from '#lib/server/icon-set.js';
import { renderDescription } from '#lib/server/markdown.js';
import { gameData } from '#lib/server/pipeline/game-data.js';
import { readPrintDoc } from '#lib/server/pipeline/print-doc.js';
import type { PageServerLoad } from './$types';

/**
 * The print and its analysis. The viewer's entity data is fetched by the page itself
 * (`/prints/[id]/viewer`), so `?page=` changes don't re-run this load.
 */
export const load: PageServerLoad = async ({ params }) => {
	// The print page reads only its R2 document, never D1.
	const found = await readPrintDoc(env.RAW, params.id);
	if (!found) error(404, 'Print not found');
	const a = found.analysis;
	const icons = iconSet(
		{
			recipe: Object.keys(a.recipes),
			entity: Object.keys(a.entities),
			item: [
				...Object.keys(a.modules).map((m) => m.split('@')[0]),
				...Object.keys(a.rates).map((s) => s.slice(s.indexOf(':') + 1)),
				// Page icons, and what each page makes and takes.
				...signalItems(a.nodes.flatMap((n) => [...n.icons, ...n.outputs, ...n.products, ...n.inputs]))
			]
		},
		[String(found.print.title), ...a.nodes.map((n) => n.label)]
	);
	// Crafting-menu section per item a page makes, for grouping what isn't a main product.
	const sections = Object.fromEntries(
		[...new Set(a.nodes.flatMap((n) => [...n.outputs, ...n.products]))].map((signal) => {
			const name = signal.slice(signal.indexOf(':') + 1);
			const section = sectionOf(name, gameData.itemInfo[name]?.group ?? '') ?? (signal.startsWith('fluid:') ? 'Fluids' : 'Other');
			return [signal, section];
		})
	);
	// Untrusted Markdown from factorioprints.com users, sanitised here so the page can use {@html}.
	const descriptionHtml = renderDescription(String(found.print.description_md ?? ''));
	return { ...found, icons, sections, descriptionHtml };
};
