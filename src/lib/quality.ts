/**
 * Quality in search filters. A Makes, Built with or Modules value can carry a quality, `@` and a
 * level (`?uses=entity:beacon@epic`), meaning that item at that quality or above. Without one it
 * means any quality. `?quality=legendary` (repeatable) asks for prints with anything at that level.
 */

/** Levels above normal, lowest first, as the game orders them. */
export const QUALITY_LEVELS = ['uncommon', 'rare', 'epic', 'legendary'] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

export const isQualityLevel = (v: string): v is QualityLevel => (QUALITY_LEVELS as readonly string[]).includes(v);

/** Filters whose values can carry a quality. */
export const QUALITY_FILTERS = ['makes', 'uses', 'module'] as const;
export const takesQuality = (key: string) => (QUALITY_FILTERS as readonly string[]).includes(key);

/** "entity:beacon@epic" → the value and its quality; a value without a known level after `@` has none. */
export const splitQuality = (value: string): { base: string; quality: QualityLevel | null } => {
	const at = value.lastIndexOf('@');
	const level = at < 0 ? '' : value.slice(at + 1);
	return isQualityLevel(level) ? { base: value.slice(0, at), quality: level } : { base: value, quality: null };
};

export const withQualityValue = (base: string, quality: QualityLevel | null) => (quality ? `${base}@${quality}` : base);

/** A level and every one above it: "rare" → rare, epic, legendary. */
export const atOrAbove = (quality: QualityLevel) => QUALITY_LEVELS.slice(QUALITY_LEVELS.indexOf(quality));

/** Words for a chip's choice: short in the dropdown, long in the phone sheet and labels. */
export const QUALITY_WORDS: Record<QualityLevel | 'any', { short: string; long: string }> = {
	any: { short: 'Any', long: 'Any quality' },
	uncommon: { short: 'Uncommon+', long: 'Uncommon or above' },
	rare: { short: 'Rare+', long: 'Rare or above' },
	epic: { short: 'Epic+', long: 'Epic or above' },
	legendary: { short: 'Legendary', long: 'Legendary' }
};

/** The game's own "no quality set" icon, from filter and signal pickers (`__core__/graphics/icons/any-quality.png`). */
export const ANY_QUALITY_ICON = 'virtual:signal-any-quality';
