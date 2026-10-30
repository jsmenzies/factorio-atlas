/**
 * Print ids: the one place that says what a print id looks like. A print's id is its URL
 * (`/prints/<id>`) and never changes. Browser-safe.
 *
 * - factorioprints prints keep factorioprints' own id: 20 characters of `-_0-9A-Za-z` (Firebase push ids).
 * - Uploads: `up-` and 10 base62 characters (the upload's site id).
 * - Prints first seen on another site: the site's prefix and the site's own id, `fbin-LYMz5ZJT`,
 *   `codex-492`, `fprints-<uuid>`. Never 20 characters, so never in factorioprints' space.
 */

/** Every site a print can come from. */
export type Site = 'factorioprints' | 'upload' | 'factoriobin' | 'codex' | 'fprints';

export const SITES: readonly Site[] = ['factorioprints', 'upload', 'factoriobin', 'codex', 'fprints'];

/** The id prefix of each site but factorioprints, whose prints keep their own ids. */
export const SITE_PREFIX: { readonly [S in Exclude<Site, 'factorioprints'>]: string } = {
	upload: 'up',
	factoriobin: 'fbin',
	codex: 'codex',
	fprints: 'fprints'
};

/** A factorioprints id, as a pattern to build others from (the mirror's file names). */
export const FACTORIOPRINTS_ID_PATTERN = '[-_0-9A-Za-z]{20}';
export const FACTORIOPRINTS_ID = new RegExp(`^${FACTORIOPRINTS_ID_PATTERN}$`);
const UPLOAD_ID = /^up-[0-9A-Za-z]{10}$/;
const OTHER_ID = /^(fbin|codex|fprints)-[-_0-9A-Za-z]{1,64}$/;

/** A factorioprints id: the mirror's file names, Firebase keys. */
export const isFactorioprintsId = (id: string) => FACTORIOPRINTS_ID.test(id);

/** Whether `id` can be a print's id, from any site. */
export const isPrintId = (id: string) => FACTORIOPRINTS_ID.test(id) || UPLOAD_ID.test(id) || OTHER_ID.test(id);

/**
 * The id a print first seen on `site` gets. Throws when the site's id can't make one, or would make a
 * 20-character id (factorioprints' space).
 */
export const printIdFor = (site: Site, siteId: string): string => {
	const id = site === 'factorioprints' ? siteId : `${SITE_PREFIX[site]}-${siteId}`;
	if (!isPrintId(id) || (site === 'factorioprints') !== isFactorioprintsId(id)) throw new Error(`no print id for ${site} ${siteId}`);
	return id;
};

/**
 * Whether a print shows a favourites count: only factorioprints records have one. `site` is the site of
 * the record the print shows (`prints.source`, the document's `source`); documents written before it
 * carried one fall back to the print id's site.
 */
export const showsFavourites = (site: Site | string | null | undefined, id: string) => (site ?? siteOfPrintId(id)) === 'factorioprints';

/** The site whose id space `id` is in: where the print was first seen, not necessarily what it shows. */
export const siteOfPrintId = (id: string): Site | null => {
	if (FACTORIOPRINTS_ID.test(id)) return 'factorioprints';
	if (!isPrintId(id)) return null;
	const prefix = id.slice(0, id.indexOf('-'));
	return (Object.entries(SITE_PREFIX) as [Exclude<Site, 'factorioprints'>, string][]).find(([, p]) => p === prefix)?.[0] ?? null;
};
