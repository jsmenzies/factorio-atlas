/**
 * Game icons: one 64 px WebP per prototype, made by `bun run icons` from the game's own icon dump
 * and served from the SPRITES bucket as `<base>/<type>/<name>.webp`. Pages get only the icons they
 * show (an `IconSet`) from their server load, already resolved to a file, so anything without one
 * (modded names) falls back to a blank slot without a request.
 *
 * Icons are Wube's art. `Icon.svelte` is the one place that draws them, and `ICONS_ON` switches
 * them all off.
 */
export const ICONS_ON = true;

/** Prototype types with icons, named as the game's `--dump-icon-sprites` names its folders. */
export const ICON_TYPES = [
	'item',
	'fluid',
	'recipe',
	'entity',
	'virtual-signal',
	'tile',
	'quality',
	'space-location',
	'technology',
	'item-group',
	'asteroid-chunk'
] as const;

/**
 * What a caller asks for. The server resolves it to a file with fallbacks: `item` also finds
 * fluids (signals are often passed by bare name), `recipe` its product, `entity` the item that
 * places it.
 */
export type IconKind = (typeof ICON_TYPES)[number];

export interface IconSet {
	/** URL prefix of the icon set, without a trailing slash. */
	base: string;
	/** `<kind>/<name>` → the file it resolved to, `<type>/<name>` without `.webp`. */
	of: Record<string, string>;
}

export const iconKey = (kind: IconKind, name: string) => `${kind}/${name}`;

/** The icon's URL, or undefined when there is none (or icons are off). */
export const iconUrl = (icons: IconSet, kind: IconKind, name: string): string | undefined => {
	if (!ICONS_ON) return undefined;
	const file = icons.of[iconKey(kind, name)];
	return file === undefined ? undefined : `${icons.base}/${file}.webp`;
};

/** Signal and rich-text types to icon kinds. */
const KINDS: Record<string, IconKind> = {
	...Object.fromEntries(ICON_TYPES.map((t) => [t, t])),
	virtual: 'virtual-signal',
	planet: 'space-location'
};

/** The icon kind for a signal or rich-text type (`virtual` → `virtual-signal`), if it has icons. */
export const iconKindOf = (type: string): IconKind | undefined => KINDS[type];

/** "fluid:water" → {kind: 'fluid', name: 'water'}; a bare name is an item. */
export const signalIcon = (signal: string): { kind: IconKind; name: string } => {
	const i = signal.indexOf(':');
	if (i < 0) return { kind: 'item', name: signal };
	return { kind: iconKindOf(signal.slice(0, i)) ?? 'item', name: signal.slice(i + 1) };
};
