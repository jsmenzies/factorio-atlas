/**
 * Game icons, as cells of one sprite sheet. Pages get only the cells they show (an `IconSet`)
 * from their server load, and anything without a cell (modded names) falls back to text.
 * Icons are Wube's art; `Icon.svelte` is the one place that draws them, so they can be switched off there.
 */
export interface IconSet {
	sheet: { url: string; width: number; height: number; size: number };
	recipe: Record<string, [number, number]>;
	entity: Record<string, [number, number]>;
	item: Record<string, [number, number]>;
}

export type IconKind = 'recipe' | 'entity' | 'item';
