/**
 * One-line, human summaries of what a page or print does, built from analyzer output.
 * Production pages lead with what they make; infra pages with what they're made of.
 */
import type { Category, Role } from './server/pipeline/analyze.js';
import type { PageAnalysis, PageNode } from './server/pipeline/print-doc.js';
import { formatRate, signalName } from './format.js';
import { plainText } from './richtext.js';

type Counts = Record<string, number>;

export const ROLE_LABEL: Record<Role, string> = {
	production: 'Production',
	mining: 'Mining',
	research: 'Research',
	belts: 'Belts',
	inserters: 'Inserters',
	fluids: 'Fluids',
	power: 'Power',
	circuits: 'Circuits',
	rail: 'Rail',
	defence: 'Defence',
	bots: 'Bots',
	storage: 'Storage',
	platform: 'Space platform',
	other: 'Other',
	empty: 'Empty'
};

/** Chip colours per role; text always says the role too, so colour is never the only cue. */
export const ROLE_CLASS: Record<Role, string> = {
	production: 'bg-emerald-900/50 text-emerald-300',
	mining: 'bg-yellow-900/50 text-yellow-300',
	research: 'bg-sky-900/50 text-sky-300',
	belts: 'bg-amber-900/50 text-amber-300',
	inserters: 'bg-amber-900/50 text-amber-300',
	fluids: 'bg-cyan-900/50 text-cyan-300',
	power: 'bg-lime-900/50 text-lime-300',
	circuits: 'bg-red-900/50 text-red-300',
	rail: 'bg-stone-700 text-stone-200',
	defence: 'bg-rose-900/50 text-rose-300',
	bots: 'bg-violet-900/50 text-violet-300',
	storage: 'bg-stone-800 text-stone-300',
	platform: 'bg-indigo-900/50 text-indigo-300',
	other: 'bg-stone-800 text-stone-400',
	empty: 'bg-stone-800 text-stone-500'
};

const plural = (n: number, name: string) => {
	const word = signalName(name).toLowerCase();
	return `${n.toLocaleString()} ${n === 1 || word.endsWith('s') ? word : `${word}s`}`;
};

/** "196 solar panels · 166 accumulators", largest first. */
const topCounts = (c: Counts | undefined, k = 3, keep: (name: string) => boolean = () => true) =>
	Object.entries(c ?? {})
		.filter(([n]) => keep(n))
		.slice(0, k)
		.map(([n, x]) => plural(x, n))
		.join(' · ');

const sum = (c: Counts | undefined, keep: (name: string) => boolean = () => true) =>
	Object.entries(c ?? {}).reduce((s, [n, x]) => (keep(n) ? s + x : s), 0);

const list = (signals: string[], k = 3) =>
	signals.slice(0, k).map(signalName).join(', ') + (signals.length > k ? ` +${signals.length - k}` : '');

const isPole = (n: string) => /pole|substation/.test(n);
const isSignal = (n: string) => /signal/.test(n);
const isRollingStock = (n: string) => /locomotive|wagon/.test(n);

/** What `describeCategory` says beyond entity counts. */
interface CategoryContext {
	beltThroughput?: number | null;
	trainStops?: string[];
	wires?: { red: number; green: number };
	signs?: number;
}

/** One page's context; `beltThroughput` is passed in, since page rows leave it out. */
const nodeContext = (n: PageNode, beltThroughput: number | null): CategoryContext => ({
	beltThroughput,
	trainStops: n.trainStops.flatMap((s) => (s.name ? [s.name] : [])),
	wires: n.wires,
	signs: n.signs
});

/** Infra headline for one category, shared by page rows and print cards. */
export const describeCategory = (cat: Category, c: Partial<Record<Category, Counts>>, extra: CategoryContext): string => {
	const counts = c[cat];
	switch (cat) {
		case 'belts': {
			const splitters = sum(counts, (n) => /splitter/.test(n));
			const undergrounds = sum(counts, (n) => /underground/.test(n));
			const belts = sum(counts, (n) => n.endsWith('transport-belt'));
			const parts = [
				belts && plural(belts, 'belt'),
				splitters && plural(splitters, 'splitter'),
				undergrounds && plural(undergrounds, 'underground')
			].filter(Boolean);
			const fastest = extra.beltThroughput ? ` · up to ${extra.beltThroughput}/s per belt` : '';
			return parts.join(' · ') + fastest;
		}
		case 'rail': {
			const stops = extra.trainStops ?? [];
			const signals = sum(counts, isSignal);
			const rails = sum(counts, (n) => /rail/.test(n) && !isSignal(n));
			const stock = sum(counts, isRollingStock);
			return [
				stops.length && `${plural(stops.length, 'station')} (${stops.slice(0, 3).join(', ')}${stops.length > 3 ? '…' : ''})`,
				rails && plural(rails, 'rail piece'),
				signals && plural(signals, 'signal'),
				stock && plural(stock, 'locomotive/wagon')
			]
				.filter(Boolean)
				.join(' · ');
		}
		case 'power':
			return topCounts(counts, 3, (n) => !isPole(n)) || topCounts(counts, 2);
		case 'circuits': {
			const combinators = sum(counts, (n) => /combinator/.test(n)) - (extra.signs ?? 0);
			const wires = (extra.wires?.red ?? 0) + (extra.wires?.green ?? 0);
			return [
				combinators > 0 && plural(combinators, 'combinator'),
				wires && plural(wires, 'wire'),
				extra.signs && `${plural(extra.signs, 'sign')} (labels)`,
				topCounts(counts, 2, (n) => !/combinator/.test(n))
			]
				.filter(Boolean)
				.join(' · ');
		}
		default:
			return topCounts(counts);
	}
};

/** What one page does. `withRate` adds the estimate, for places with no separate rate column. */
export const describeNode = (n: PageNode, { withRate = false } = {}): string => {
	// Belt speed repeats on every row of a belt book, so rows leave it to the Belts card.
	const ctx = nodeContext(n, withRate ? n.beltThroughput : null);
	switch (n.role) {
		case 'production': {
			if (!n.outputs.length) {
				const furnaces = sum(n.byCategory.production, (x) => /furnace|recycler/.test(x));
				return furnaces
					? `Smelting with ${topCounts(n.byCategory.production, 2, (x) => /furnace|recycler/.test(x))}`
					: `Crafts ${list(Object.keys(n.recipes))}`;
			}
			const rate = withRate && n.estimatedRate ? ` ≈ ${formatRate(n.estimatedRate)}` : '';
			return `Makes ${list(n.outputs)}${rate}`;
		}
		case 'mining':
		case 'research':
		case 'defence':
		case 'bots':
		case 'storage':
		case 'platform':
		case 'other':
			return topCounts(n.byCategory[n.role] ?? n.entities);
		case 'empty':
			return n.tileCount ? `${n.tileCount.toLocaleString()} tiles only` : 'No entities';
		default:
			return describeCategory(n.role, n.byCategory, ctx);
	}
};

/** What a whole print is, for the header. */
export const describePrint = (a: PageAnalysis): string => {
	const pages = a.nodes.filter((n) => n.kind === 'blueprint');
	if (pages.length === 1) return describeNode(pages[0], { withRate: true });
	// Lead with what most pages make; items before fluids when tied.
	const pagesMaking: Counts = {};
	for (const n of pages) for (const o of n.outputs) pagesMaking[o] = (pagesMaking[o] ?? 0) + 1;
	const ranked = Object.keys(pagesMaking).sort(
		(x, y) => pagesMaking[y] - pagesMaking[x] || Number(x.startsWith('fluid:')) - Number(y.startsWith('fluid:')) || x.localeCompare(y)
	);
	const makes = ranked.length ? ` Makes ${list(ranked, 4)}.` : '';
	const roles = Object.keys(a.roles) as Role[];
	if (roles.length === 1) {
		// "65 belt pages": singular, as an adjective.
		const what = roles[0] === 'production' ? '' : ` ${ROLE_LABEL[roles[0]].toLowerCase().replace(/s$/, '')}`;
		return `Book of ${pages.length}${what} pages.${makes}`;
	}
	const mix = Object.entries(a.roles)
		.map(([r, k]) => `${k} ${ROLE_LABEL[r as Role].toLowerCase()}`)
		.join(' · ');
	return `Book of ${pages.length} pages: ${mix}.${makes}`;
};

/** Search engines show about this many characters of a description. */
const META_DESCRIPTION_MAX = 160;

/** "a, b and c". */
const sentenceList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** An item's English name mid-sentence: "transport belt", "power armor MK2". */
const midSentence = (signal: string) => {
	const name = signalName(signal);
	return name.charAt(0).toLowerCase() + name.slice(1);
};

/**
 * What a book is about in a few words, at most `k` things: what it crafts (`ranked`, in the page's order; science
 * packs counted together, "6 science packs"), else the roles of its pages ("rail, belts and fluids").
 */
const bookTopics = (a: PageAnalysis, ranked: string[], k: number): string => {
	// Only what a recipe in it crafts: an item that is only a page's icon (a train station's cargo wagon) isn't made.
	const makes = ranked.filter((s) => a.products.includes(s));
	const science = makes.filter((s) => s.endsWith('-science-pack'));
	const things = [
		...(science.length > 1 ? [`${science.length} science packs`] : []),
		...makes.filter((s) => science.length < 2 || !science.includes(s)).map(midSentence)
	];
	if (things.length) return `making ${sentenceList(things.slice(0, k))}`;
	const roles = (Object.entries(a.roles) as [Role, number][]).filter(([r]) => r !== 'empty').sort((x, y) => y[1] - x[1]);
	return roles.length ? `of ${sentenceList(roles.slice(0, k).map(([r]) => ROLE_LABEL[r].toLowerCase()))}` : '';
};

/**
 * The print page's `<meta name="description">`, also its link previews' text. A book: what it is and who made
 * it, then its pages and what they make in plain words ("Factorio 0.16 blueprint book by knoted: 45 pages making
 * 6 science packs, transport belt and electronic circuit."), from `makes` (what the page lists it makes, ranked), else
 * what its pages are ("137 pages of rail, belts and fluids"), dropping things until it fits. A single blueprint:
 * `describePrint`, then what it is ("Factorio 2.0 blueprint by Nilaus."). A book page (`?page=`, its own URL): that
 * page's summary and where it sits ("Page 3 of 45 in a Factorio 0.16 blueprint book by Nilaus."). With `rendered`
 * (the print, or that page, has a game render) it says so, a reason to pick the result. A summary that is still
 * too long is cut at a word, never the sentences after it.
 */
export const metaDescription = (
	a: PageAnalysis,
	author: string | null,
	{ page, rendered = false, makes = [] }: { page?: { node: PageNode; index: number }; rendered?: boolean; makes?: string[] } = {}
): string => {
	const version = /^\d+\.\d+/.exec(a.gameVersion ?? '')?.[0];
	const total = a.nodes.filter((n) => n.kind === 'blueprint').length;
	const by = author?.trim() ? ` by ${author.trim()}` : '';
	const kindOf = `Factorio${version ? ` ${version}` : ''}${a.requiresSpaceAge ? ' Space Age' : ''} blueprint${total > 1 ? ' book' : ''}${by}`;
	const render = rendered ? ' With a zoomable in-game render.' : '';
	if (total > 1 && !page) {
		for (let k = 4; k >= 1; k--) {
			const topics = bookTopics(a, makes, k);
			const text = `${kindOf}: ${total} pages${topics ? ` ${topics}` : ''}.${render}`;
			if (text.length <= META_DESCRIPTION_MAX || k === 1) return text;
		}
	}
	const kind = `${kindOf}.`;
	const what = `${page ? `Page ${page.index + 1} of ${total} in a ${kind}` : kind}${render}`;
	let summary = (page ? describeNode(page.node, { withRate: true }) : describePrint(a)).trim();
	if (summary && !/[.!?]$/.test(summary)) summary += '.';
	const room = META_DESCRIPTION_MAX - what.length - 1;
	if (summary.length > room) {
		const cut = summary.slice(0, room - 1);
		summary = `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length).replace(/[\s,·:;.]+$/, '')}…`;
	}
	return summary ? `${summary} ${what}` : what;
};

/** Infra categories worth a card for this print, in display order, with their headline. */
export const infraCards = (a: PageAnalysis): { cat: Category; title: string; headline: string }[] => {
	const c = a.byCategory;
	const cards: { cat: Category; title: string; show: boolean }[] = [
		{ cat: 'belts', title: 'Belts', show: !!c.belts },
		{ cat: 'rail', title: 'Trains', show: a.usesTrains },
		// Poles alone aren't a power setup.
		{ cat: 'power', title: 'Power', show: sum(c.power, (n) => !isPole(n)) > 0 },
		{ cat: 'defence', title: 'Defence', show: !!c.defence },
		{
			cat: 'circuits',
			title: 'Circuits',
			show: a.usesCircuits || sum(c.circuits, (n) => !/constant/.test(n)) > 0
		}
	];
	return cards
		.filter((x) => x.show)
		.map(({ cat, title }) => ({
			cat,
			title,
			headline: printCategoryHeadline(a, cat)
		}));
};

/** Every category's name as a heading, in the order the print page lists them. */
export const CATEGORY_TITLE: [Category, string][] = [
	['production', 'Production'],
	['mining', 'Mining'],
	['research', 'Research'],
	['belts', 'Belts'],
	['inserters', 'Inserters'],
	['fluids', 'Pipes & fluids'],
	['power', 'Power'],
	['rail', 'Trains'],
	['circuits', 'Circuits'],
	['bots', 'Bots'],
	['storage', 'Storage'],
	['defence', 'Defence'],
	['platform', 'Space platform'],
	['other', 'Other']
];

/** A category's headline over a whole print, as its infra card would say it ("3,303 belts · 43 splitters"). */
export const printCategoryHeadline = (a: PageAnalysis, cat: Category): string =>
	describeCategory(cat, a.byCategory, { beltThroughput: a.beltThroughput, trainStops: a.trainStops, wires: a.wires, signs: a.signs });

/** The same for one page. */
export const pageCategoryHeadline = (n: PageNode, cat: Category): string =>
	describeCategory(cat, n.byCategory, nodeContext(n, n.beltThroughput));

/**
 * A page's name: its label, or for untitled pages its own icons ("#1 · Assembling machine 2 ·
 * Electronic circuit"), which is how players tell such pages apart in game.
 */
export const pageTitle = (n: Pick<PageNode, 'label' | 'icons'>): { text: string; derived: boolean } => {
	if (n.label) return { text: n.label, derived: false };
	const numbers = n.icons.flatMap((s) => {
		const m = /^virtual:signal-([0-9A-Z])$/.exec(s);
		return m ? [m[1]] : [];
	});
	const named = n.icons.filter((s) => !s.startsWith('virtual:')).map(signalName);
	const text = [numbers.length ? `#${numbers.join('')}` : '', ...named].filter(Boolean).join(' · ');
	return { text: text || 'Untitled', derived: true };
};

/** Machines, modules and beacons on a production page or a whole print: "20 assembling machine 2s · 40 productivity module 3s". */
export const describeSetup = (n: Pick<PageNode, 'modules' | 'entities' | 'byCategory'>): string => {
	const modules: Counts = {};
	for (const [m, x] of Object.entries(n.modules)) modules[m.split('@')[0]] = (modules[m.split('@')[0]] ?? 0) + x;
	const beacons = sum(n.entities, (x) => /beacon/.test(x));
	return [topCounts(n.byCategory.production, 2, (x) => !/beacon/.test(x)), topCounts(modules, 2), beacons && plural(beacons, 'beacon')]
		.filter(Boolean)
		.join(' · ');
};

export interface MadeItem {
	signal: string;
	/** Best rate any single page reaches (items/s); claimed when the label states it. */
	rate: number | null;
	claimed: boolean;
	/** Book paths of the pages that make it. More than one usually means variants, not extra output. */
	pages: string[];
}

export interface ProductGroup {
	name: string;
	items: MadeItem[];
}

const MALL_LABEL = /\b(mall|shop)s?\b/i;

/** Pages that make many different things for building with: malls and "shops". */
export const isMall = (n: PageNode) => n.role === 'production' && (n.products.length >= 4 || MALL_LABEL.test(n.label ?? ''));

export const GROUP_ORDER = ['Science', 'Intermediates', 'Mall & shops', 'Logistics', 'Production', 'Combat', 'Space', 'Fluids', 'Other'];

/**
 * What a print makes, split into what matters and the rest. Main products are what some
 * (non-mall) page makes and no page in the book uses up, science packs always included and
 * fluids never (they feed other pages). Everything else is grouped: mall and shop products
 * together, the rest by crafting-menu section. Rates are the best single page's, never a sum:
 * books are mostly variants of one build (plain vs gear-input), and adding them would
 * overstate what anyone builds. `inBook` says the pages are (some of) a book's, so a mall page's
 * products count too.
 */
export const bookProducts = (
	pages: PageNode[],
	sectionOf: (signal: string) => string,
	maxMain = 8,
	inBook = pages.length > 1
): { main: MadeItem[]; groups: ProductGroup[] } => {
	const made = new Map<string, MadeItem>();
	const fromMall = new Set<string>();
	const fromBuild = new Set<string>();
	for (const n of pages) {
		const mall = inBook && isMall(n);
		const signals = mall ? [...new Set([...n.outputs, ...n.products])] : n.outputs;
		signals.forEach((signal, i) => {
			const claimed = i === 0 && n.claimedRate ? n.claimedRate : null;
			const rate = claimed ?? (n.rates[signal] > 0 ? n.rates[signal] : null);
			const prev = made.get(signal);
			if (!prev) made.set(signal, { signal, rate, claimed: claimed !== null, pages: [n.path] });
			else {
				if (!prev.pages.includes(n.path)) prev.pages.push(n.path);
				if (rate !== null && (prev.rate === null || rate > prev.rate)) Object.assign(prev, { rate, claimed: claimed !== null });
			}
			(mall ? fromMall : fromBuild).add(signal);
		});
	}
	const consumed = new Set(pages.flatMap((n) => n.inputs));
	const all = [...made.values()];
	const isScience = (m: MadeItem) => sectionOf(m.signal) === 'Science';
	let main = all.filter((m) => fromBuild.has(m.signal) && !m.signal.startsWith('fluid:') && (isScience(m) || !consumed.has(m.signal)));
	// A print that only makes intermediates or fluids (an oil setup) still leads with them.
	if (!main.length) main = all.filter((m) => fromBuild.has(m.signal));
	main = main.sort((x, y) => Number(isScience(y)) - Number(isScience(x)) || y.pages.length - x.pages.length).slice(0, maxMain);

	const shown = new Set(main.map((m) => m.signal));
	const groups = new Map<string, MadeItem[]>();
	for (const m of all) {
		if (shown.has(m.signal)) continue;
		const name = fromMall.has(m.signal) && !fromBuild.has(m.signal) ? 'Mall & shops' : sectionOf(m.signal);
		groups.set(name, [...(groups.get(name) ?? []), m]);
	}
	return {
		main,
		groups: [...groups].map(([name, items]) => ({ name, items })).sort((a, b) => GROUP_ORDER.indexOf(a.name) - GROUP_ORDER.indexOf(b.name))
	};
};

const STAGE = /^\s*(\d+)\s*[.)]\s*(.+)$/;

/**
 * A book in one line: its build stages when the labels are numbered ("1. Gears", "2. Steam
 * Power"), else its page count, then the mix of roles.
 */
export const describeBook = (a: PageAnalysis): string => {
	const pages = a.nodes.filter((n) => n.kind === 'blueprint');
	const roles = Object.entries(a.roles) as [Role, number][];
	const mix =
		roles.length === 1
			? `All ${ROLE_LABEL[roles[0][0]].toLowerCase().replace(/s$/, '')} pages.`
			: `${roles.map(([r, k]) => `${k} ${ROLE_LABEL[r].toLowerCase()}`).join(', ')}.`;
	const staged = pages.flatMap((n) => {
		const m = STAGE.exec(plainText(n.label ?? ''));
		return m ? [{ stage: Number(m[1]), name: m[2].trim() }] : [];
	});
	if (staged.length >= 3 && staged.length >= pages.length * 0.6) {
		const stages = new Set(staged.map((x) => x.stage));
		const first = staged.reduce((x, y) => (y.stage < x.stage ? y : x));
		const last = staged.reduce((x, y) => (y.stage > x.stage ? y : x));
		return `${pages.length} pages in ${stages.size} build stages, from “${first.name}” to “${last.name}”. ${mix}`;
	}
	return `Book of ${pages.length} pages. ${mix}`;
};

/** One count in a page's facts, drawn as its icon: an entity, or a module (an item, maybe above normal quality). */
export interface IconCount {
	kind: 'entity' | 'item';
	name: string;
	quality?: string;
	n: number;
	/** "48 stone furnaces", for the tooltip. */
	label: string;
}

/** A line of a page's facts: counts as icons, then what counts can't say ("up to 15/s per belt"). */
export interface FactLine {
	title: string;
	counts: IconCount[];
	notes: string[];
}

/** Entity counts as icons, largest first. */
const entityCounts = (c: Counts | undefined, keep: (name: string) => boolean = () => true, k = 4): IconCount[] =>
	Object.entries(c ?? {})
		.filter(([name, n]) => n > 0 && keep(name))
		.sort((x, y) => y[1] - x[1])
		.slice(0, k)
		.map(([name, n]) => ({ kind: 'entity', name, n, label: plural(n, name) }));

/** `describeSetup` as icons: machines, modules (by quality) and beacons. */
export const setupCounts = (n: Pick<PageNode, 'modules' | 'entities' | 'byCategory'>): IconCount[] => {
	const modules = Object.entries(n.modules)
		.sort((x, y) => y[1] - x[1])
		.slice(0, 4)
		.map(([key, x]): IconCount => {
			const [name, quality] = key.split('@');
			return { kind: 'item', name, quality, n: x, label: plural(x, name) + (quality ? ` (${quality})` : '') };
		});
	return [
		...entityCounts(n.byCategory.production, (x) => !/beacon/.test(x)),
		...modules,
		...entityCounts(n.entities, (x) => /beacon/.test(x), 2)
	];
};

/** One page's infra as lines of icons ("Belts: [belt] 75 [splitter] 12"), for the selected-page panel. */
export const pageInfra = (n: PageNode): FactLine[] => {
	const c = n.byCategory;
	const lines: FactLine[] = [];
	if (c.belts) {
		const kinds = [(x: string) => x.endsWith('transport-belt'), (x: string) => /splitter/.test(x), (x: string) => /underground/.test(x)];
		lines.push({
			title: 'Belts',
			counts: kinds.flatMap((keep) => entityCounts(c.belts, keep)),
			notes: n.beltThroughput ? [`up to ${n.beltThroughput}/s per belt`] : []
		});
	}
	if (c.rail) {
		const stops = n.trainStops.flatMap((s) => (s.name ? [s.name] : []));
		// Straight, curved and diagonal pieces share one icon: count them together.
		const rails = Object.entries(c.rail).filter(([x]) => /rail/.test(x) && !isSignal(x));
		const railCount = rails.reduce((s, [, x]) => s + x, 0);
		const largest = rails.reduce<[string, number] | null>((m, r) => (!m || r[1] > m[1] ? r : m), null);
		lines.push({
			title: 'Trains',
			counts: [
				...(largest ? [{ kind: 'entity' as const, name: largest[0], n: railCount, label: plural(railCount, 'rail piece') }] : []),
				...entityCounts(c.rail, isSignal),
				...entityCounts(c.rail, isRollingStock)
			],
			notes: stops.length ? [`${plural(stops.length, 'station')} (${stops.slice(0, 3).join(', ')}${stops.length > 3 ? '…' : ''})`] : []
		});
	}
	if (sum(c.power, (x) => !isPole(x)) > 0) lines.push({ title: 'Power', counts: entityCounts(c.power, (x) => !isPole(x)), notes: [] });
	if (c.defence) lines.push({ title: 'Defence', counts: entityCounts(c.defence), notes: [] });
	if (n.circuitControlled > 0 || sum(c.circuits, (x) => !/constant|lamp/.test(x)) > 0) {
		// Signs are constant combinators too; they get their own note.
		const combinators = entityCounts(c.circuits, (x) => /combinator/.test(x), Infinity)
			.map((x) => (x.name === 'constant-combinator' ? { ...x, n: x.n - n.signs, label: plural(x.n - n.signs, x.name) } : x))
			.filter((x) => x.n > 0);
		const wires = n.wires.red + n.wires.green;
		lines.push({
			title: 'Circuits',
			counts: [...combinators, ...entityCounts(c.circuits, (x) => !/combinator/.test(x), 2)],
			notes: [wires && plural(wires, 'wire'), n.signs && `${plural(n.signs, 'sign')} (labels)`].filter((x): x is string => !!x)
		});
	}
	return lines.filter((x) => x.counts.length || x.notes.length);
};
