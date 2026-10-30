/**
 * The sites prints come from, as the site shows them: one entry per site with its name and how to build
 * the public page of a site id. Browser-safe. Ids and prefixes are print-id.ts's.
 *
 * A print can have several live sources (`print_sources`, migration 0022): its R2 document lists them,
 * credited first (`PrintDoc.print.sources`, written by the pipeline's `syncSources`). Documents without a
 * list have one source, the site the print was first seen on, read from the print's id (`ownSource`).
 */
import { SITE_PREFIX, siteOfPrintId, type Site } from './print-id';

export interface SiteInfo {
	/** As shown: "factorioprints.com". */
	readonly name: string;
	/** The print's page on that site; null for uploads, whose page is the print's own. */
	readonly url: ((siteId: string) => string) | null;
}

export const SOURCE_SITES: { readonly [S in Site]: SiteInfo } = {
	factorioprints: { name: 'factorioprints.com', url: (id) => `https://factorioprints.com/view/${id}` },
	upload: { name: 'Blueprint Atlas', url: null },
	factoriobin: { name: 'factoriobin.com', url: (id) => `https://factoriobin.com/post/${id}` },
	codex: { name: 'factoriocodex.com', url: (id) => `https://factoriocodex.com/blueprints/${id}` },
	fprints: { name: 'fprints.xyz', url: (id) => `https://fprints.xyz/blueprint/${id}` }
};

/** One place a print was posted, as its document lists it. */
export interface PrintSource {
	readonly site: Site;
	readonly site_id: string;
}

/** The page of `siteId` on `site`; null for uploads (and a site this build doesn't know). */
export const siteUrl = (site: Site, siteId: string): string | null => SOURCE_SITES[site]?.url?.(encodeURIComponent(siteId)) ?? null;

/** A source's URL as link text: without the scheme. */
export const urlText = (url: string) => url.replace(/^https?:\/\//, '');

/** The source a print was first seen on, read from its id (its URL never changes); null for an id no site makes. */
export const ownSource = (printId: string): PrintSource | null => {
	const site = siteOfPrintId(printId);
	if (site === null) return null;
	return { site, site_id: site === 'factorioprints' ? printId : printId.slice(SITE_PREFIX[site].length + 1) };
};

/**
 * The page of the print on the site it was first seen on, when that is another site: factorioprints,
 * factoriobin, codex, fprints. Null for uploads and ids no site makes.
 */
export const sourceUrl = (printId: string): string | null => {
	const own = ownSource(printId);
	return own ? siteUrl(own.site, own.site_id) : null;
};

/** A print's live sources, credited first: its document's list, else the one its id names. */
export const sourcesOfPrint = (print: { readonly id: string; readonly sources?: readonly PrintSource[] }): readonly PrintSource[] => {
	if (print.sources?.length) return print.sources;
	const own = ownSource(print.id);
	return own ? [own] : [];
};

/**
 * What a document stores for these live sources (credited first): undefined when they are just the
 * print's own source, which readers assume when a document has no list, so the usual print's document
 * never carries one.
 */
export const docSources = (printId: string, live: readonly PrintSource[]): PrintSource[] | undefined => {
	const own = ownSource(printId);
	if (live.length === 0) return undefined;
	if (live.length === 1 && own && live[0].site === own.site && live[0].site_id === own.site_id) return undefined;
	return live.map((s) => ({ site: s.site, site_id: s.site_id }));
};
