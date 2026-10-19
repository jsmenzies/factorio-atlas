import type { IconKind, IconSet } from '#lib/icons.js';
import { richTextIcons } from '#lib/richtext.js';
import { gameData } from '#lib/server/pipeline/game-data.js';

/** Only the sprite cells a page shows, not the whole icon index. Unknown names are skipped. */
export const iconSet = (names: Partial<Record<IconKind, Iterable<string>>>, richText: (string | null | undefined)[] = []): IconSet => {
	const fromText = richTextIcons(richText);
	const cells = (kind: IconKind) =>
		Object.fromEntries(
			[...new Set([...(names[kind] ?? []), ...fromText[kind]])].flatMap((n) => {
				const cell = gameData.iconOf(kind, n);
				return cell ? [[n, cell]] : [];
			})
		);
	return { sheet: gameData.icons.sheet, item: cells('item'), entity: cells('entity'), recipe: cells('recipe') };
};

/** "item:iron-plate" / "fluid:water" → "iron-plate"; virtual signals have no sprite and are dropped. */
export const signalItems = (signals: Iterable<string>): string[] =>
	[...signals].filter((s) => !s.startsWith('virtual:')).map((s) => s.slice(s.indexOf(':') + 1));
