import manifest from '../../../data/game/icons.json';
import { ICON_TYPES, iconKey, signalIcon, type IconKind, type IconSet } from '#lib/icons.js';
import { richTextIcons } from '#lib/richtext.js';
import { gameData } from '#lib/server/pipeline/game-data.js';
import { spritesBase } from '#lib/server/sprites.js';

/** Shape of `data/game/icons.json`, written by scripts/icons.ts: which icons the set has. */
export interface IconManifest {
	gameVersion: string;
	/** `<game version>-<content hash>`: the set's folder, `icons/<set>/<type>/<name>.webp`. */
	set: string;
	size: number;
	types: Partial<Record<IconKind, string[]>>;
}

const icons = manifest as IconManifest;
const have = new Map(ICON_TYPES.map((t) => [t, new Set(icons.types[t] ?? [])]));

/** Files to try for a kind and name, in order. */
const candidates = (kind: IconKind, name: string): [IconKind, string][] => {
	switch (kind) {
		case 'item':
			return [
				['item', name],
				['fluid', name]
			];
		case 'fluid':
			return [
				['fluid', name],
				['item', name]
			];
		case 'recipe':
			return [
				['recipe', name],
				['item', name],
				['fluid', name]
			];
		case 'entity':
			return [
				['entity', name],
				['item', gameData.entityItem[name] ?? name]
			];
		default:
			return [[kind, name]];
	}
};

const MIGRATES: Partial<Record<IconKind, 'entity' | 'item' | 'recipe' | 'tile'>> = {
	item: 'item',
	fluid: 'item',
	recipe: 'recipe',
	entity: 'entity',
	tile: 'tile'
};

/** The file for an icon, `<type>/<name>`; pre-2.0 names are tried under their 2.0 name too. */
export const resolveIcon = (kind: IconKind, name: string): string | undefined => {
	const migrates = MIGRATES[kind];
	const renamed = migrates ? gameData.migrate(migrates, name) : name;
	for (const n of renamed === name ? [name] : [name, renamed]) {
		for (const [type, file] of candidates(kind, n)) if (have.get(type)?.has(file)) return `${type}/${file}`;
	}
	return undefined;
};

/** Where the icon set is served from. */
export const iconBase = () => `${spritesBase()}/icons/${icons.set}`;

/**
 * Only the icons a page shows, not the whole index: names by kind, signals (`fluid:water`,
 * `virtual:signal-A`) and the icons in rich text. Names without an icon are left out.
 */
export const iconSet = (
	names: Partial<Record<IconKind, Iterable<string>>> & { signals?: Iterable<string> },
	richText: (string | null | undefined)[] = []
): IconSet => {
	const of: Record<string, string> = {};
	const add = (kind: IconKind, name: string) => {
		const key = iconKey(kind, name);
		if (key in of) return;
		const file = resolveIcon(kind, name);
		if (file) of[key] = file;
	};
	for (const kind of ICON_TYPES) for (const n of names[kind] ?? []) add(kind, n);
	for (const [kind, list] of Object.entries(richTextIcons(richText)) as [IconKind, string[]][]) for (const n of list) add(kind, n);
	for (const s of names.signals ?? []) {
		const { kind, name } = signalIcon(s);
		add(kind, name);
	}
	return { base: iconBase(), of };
};
