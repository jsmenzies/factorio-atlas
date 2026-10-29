import { bookProducts } from '#lib/describe.js';
import { sectionOf } from '#lib/picker.js';
import { iconSet } from '#lib/server/icon-set.js';
import { landingLinks } from '#lib/server/picker-items.js';
import { renderDescription } from '#lib/server/markdown.js';
import { gameData } from '#lib/server/pipeline/game-data.js';
import { loadPrintDoc, printTexts } from '#lib/server/print-pages.js';
import { pageThumbs, renderBase, renderOverviews } from '#lib/server/renders.js';
import { loadShotView } from '#lib/server/screenshots.js';
import type { PageServerLoad } from './$types';

/**
 * The print, its analysis and which pages have a game render. The viewer's data is fetched by
 * the page itself (`/prints/[id]/viewer`), so `?page=` changes don't re-run this load.
 */
export const load: PageServerLoad = async ({ params }) => {
	// The print page reads only R2 (its document, render index, thumbnails and screenshot manifest), never D1.
	const thumbs = pageThumbs(params.id);
	const [found, overviews] = await loadPrintDoc(params.id, renderOverviews(params.id));
	const shot = await loadShotView(found.print);
	const a = found.analysis;
	// Each rendered page's overview image: the Overview tab's preview, and the header's background
	// when the author has no screenshot.
	const previews: Record<string, string> = Object.fromEntries(
		Object.entries(overviews).map(([path, file]) => [path, `${renderBase(params.id)}/${file}`])
	);
	// The header's background: the rendered page with the most entities, as a print's first page
	// is often a small header or a thin strip of track.
	const biggest = a.nodes.filter((n) => n.path in previews).sort((x, y) => y.entityCount - x.entityCount)[0];
	const cover = biggest ? { path: biggest.path, url: previews[biggest.path] } : null;
	// What each recipe takes and makes, from the game data, for the Recipes tab.
	const recipes = Object.fromEntries(
		Object.keys(a.recipes).map((name) => {
			const r = gameData.recipes[name];
			const main = r?.results[0]?.[0] ?? name;
			const section = sectionOf(main, gameData.itemInfo[main]?.group ?? '') ?? 'Other';
			return [name, { section, time: r?.time ?? null, ingredients: r?.ingredients ?? [], results: r?.results ?? [] }];
		})
	);
	const recipeItems = Object.values(recipes).flatMap((r) => [...r.ingredients, ...r.results].map(([name]) => name));
	const icons = iconSet(
		{
			recipe: Object.keys(a.recipes),
			entity: Object.keys(a.entities),
			item: [...Object.keys(a.modules).map((m) => m.split('@')[0]), ...recipeItems],
			tile: Object.keys(a.tiles),
			// Badges on entities and modules, and the Entities tab's quality filter.
			quality: ['normal', ...Object.keys(a.qualities)],
			// Rates, page icons, and what each page makes and takes.
			signals: [
				...Object.keys(a.rates),
				...a.nodes.flatMap((n) => [...n.icons, ...n.outputs, ...n.products, ...n.inputs, ...n.intermediates])
			]
		},
		// Station names may hold rich-text icons too.
		[...printTexts(found), ...a.trainStops]
	);
	// Crafting-menu section per item a page makes, for grouping what isn't a main product.
	const sections = Object.fromEntries(
		[...new Set(a.nodes.flatMap((n) => [...n.outputs, ...n.products]))].map((signal) => {
			const name = signal.slice(signal.indexOf(':') + 1);
			const section = sectionOf(name, gameData.itemInfo[name]?.group ?? '') ?? (signal.startsWith('fluid:') ? 'Fluids' : 'Other');
			return [signal, section];
		})
	);
	const made = bookProducts(
		a.nodes.filter((n) => n.kind === 'blueprint'),
		(signal) => sections[signal] ?? 'Other'
	);
	const ranked = [...made.main, ...made.groups.flatMap((g) => g.items)].map((m) => m.signal);
	// The crafting menu's order (tab|row|item) per item a page makes or uses inside, for the Produces tab.
	const menuOrder = Object.fromEntries(
		[...new Set(a.nodes.flatMap((n) => [...n.outputs, ...n.products, ...n.intermediates]))].map((signal) => [
			signal,
			gameData.itemInfo[signal.slice(signal.indexOf(':') + 1)]?.sort ?? 'z|z|'
		])
	);
	// Untrusted Markdown from factorioprints.com users, sanitised here so the page can use {@html}. The
	// Markdown itself stays here: the page needs only the HTML, and whether to fold a long one.
	const { description_md, ...print } = found.print;
	const markdown = String(description_md ?? '');
	const descriptionHtml = renderDescription(markdown);
	return {
		...found,
		print,
		icons,
		sections,
		menuOrder,
		recipes,
		descriptionHtml,
		descriptionLong: markdown.length > 900,
		previews,
		cover,
		thumbs: await thumbs,
		shot,
		// Links to the landing pages of what it makes and is built with (the sidebar's "Search for more blueprints"),
		// what it makes ranked as the page ranks it.
		landings: landingLinks(a, ranked)
	};
};
