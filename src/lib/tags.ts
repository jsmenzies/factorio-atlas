/**
 * factorioprints author tags look like "/general/early game/" or "/version/0,17/". Version tags
 * filter like the version facet; the rest filter by the raw tag.
 */
export interface AuthorTag {
	raw: string;
	category: string;
	label: string;
	/** The search param this tag sets when clicked. */
	param: { key: 'version' | 'tag'; value: string };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const parseTag = (raw: string): AuthorTag => {
	const [category = '', value = raw] = raw.split('/').filter(Boolean);
	if (category === 'version') {
		const v = value.replace(',', '.');
		return { raw, category, label: v, param: { key: 'version', value: v } };
	}
	return {
		raw,
		category,
		label: capitalise(value),
		param: { key: 'tag', value: raw }
	};
};

/** Categories that say most about a build, first. Unlisted categories go last. */
const TAG_PRIORITY = ['general', 'belt', 'production', 'power', 'train', 'circuit', 'planets', 'mods'];

/**
 * Author tags worth showing next to our own analysis: drops the ones that repeat what we
 * detect anyway (versions, "vanilla" when no mods were found) and puts the telling ones first.
 */
export const usefulTags = (raw: string[], detectedMods: string[]): AuthorTag[] => {
	const rank = (t: AuthorTag) => {
		const i = TAG_PRIORITY.indexOf(t.category);
		return i < 0 ? TAG_PRIORITY.length : i;
	};
	return raw
		.map(parseTag)
		.filter((t) => t.category !== 'version' && !(t.raw === '/mods/vanilla/' && detectedMods.length === 0))
		.sort((a, b) => rank(a) - rank(b));
};
