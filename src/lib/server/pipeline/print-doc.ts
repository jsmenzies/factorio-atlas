/**
 * The print page's whole data source: one JSON document per print in R2, so a print page
 * never queries D1.
 */
import type { Site } from '#lib/print-id.js';
import type { PrintSource } from '#lib/sources.js';
import type { NodeAnalysis, PrintAnalysis } from './analyze.js';
import type { FoldState } from './fold.js';
import type { FirebaseRecord } from './record.js';
import { toEpochMs } from './record.js';

export const analysisKey = (id: string) => `analysis/${id}.json`;

/** Bump when the document's shape changes; readers treat other versions as missing. */
export const PRINT_DOC_VERSION = 1;

export interface PrintDoc {
	v: typeof PRINT_DOC_VERSION;
	print: {
		id: string;
		title: string;
		author_id: string | null;
		author_name: string | null;
		favorites: number;
		image_id: string | null;
		image_type: string | null;
		tags: string[];
		description_md: string;
		created_at: number | null;
		updated_at: number | null;
		source_url: string;
		/** The site of the record shown (no favourites but factorioprints'); absent from documents written before it. */
		source?: Site;
		/**
		 * Every live source of the print (`print_sources`), credited first (#lib/sources.ts `docSources`).
		 * Absent when the only one is the site the print's id names, and from documents written before it.
		 */
		sources?: PrintSource[];
		/** Only on a later exact copy, whoever posted it (the soft fold, fold.ts): the earliest print of that content. */
		copy_of?: { id: string };
		/** An exact copy by someone else, as fold.ts used to mark it (until 2026-10-30; a refold clears it): the earliest print. */
		identical_to?: { id: string };
	};
	analysis: PrintAnalysis;
}

/** The print as its page gets it: the description arrives as sanitised HTML, so the Markdown stays on the server. */
export type PagePrint = Omit<PrintDoc['print'], 'description_md'>;

/** Node fields the print page never shows (search tokens and analyzer working figures): left out of its data. */
const UNSHOWN_NODE_FIELDS = ['signItems', 'signals', 'richText', 'combinators', 'schedules', 'furnacesWithoutRecipe', 'qualities'] as const;

/** A page as the print page gets it. */
export type PageNode = Omit<NodeAnalysis, (typeof UNSHOWN_NODE_FIELDS)[number]>;

/** The analysis as the print page gets it: every page without the fields it never shows, and no print-level `labels`. */
export type PageAnalysis = Omit<PrintAnalysis, 'labels' | 'nodes'> & { nodes: PageNode[] };

/** The analysis trimmed to what the print page reads (its HTML and `__data.json` carry it twice). */
export const pageAnalysis = ({ labels: _labels, nodes, ...rest }: PrintAnalysis): PageAnalysis => ({
	...rest,
	nodes: nodes.map((n) => {
		const out: Partial<NodeAnalysis> = { ...n };
		for (const k of UNSHOWN_NODE_FIELDS) delete out[k];
		return out as PageNode;
	})
});

/**
 * The author name a record carries itself: factorioprints' `displayName`, another site's author's name. An empty
 * name counts as none, in the document as in D1.
 */
export const ownAuthorName = (record: FirebaseRecord) => record.author?.displayName || record.source?.author?.name || null;

export const toPrintDoc = (id: string, sourceUrl: string, r: FirebaseRecord, analysis: PrintAnalysis): PrintDoc => ({
	v: PRINT_DOC_VERSION,
	print: {
		id,
		title: r.title,
		author_id: r.author?.userId ?? r.authorId ?? null,
		author_name: ownAuthorName(r),
		favorites: r.numberOfFavorites ?? 0,
		image_id: r.image?.id ?? null,
		image_type: r.image?.type ?? null,
		tags: [...(r.tags ?? [])],
		description_md: r.descriptionMarkdown ?? '',
		created_at: toEpochMs(r.createdDate),
		updated_at: toEpochMs(r.lastUpdatedDate),
		source_url: sourceUrl,
		source: r.source?.site ?? 'factorioprints'
	},
	analysis
});

/*
 * Each patch below comes twice: on a document object (the ingest builds its document, patches it and
 * serialises it once) and on a stored document's text (authors, `writeFolds`, `syncSources`), which is
 * the same string when nothing changes. The object patches return the same object when nothing changes,
 * and put keys where the text patches would, so serialising the result gives the text patches' bytes.
 */

/** The document credited to `name`; the same object when it already is, or with no name. */
export const docWithAuthorName = (doc: PrintDoc, name: string | null): PrintDoc =>
	name === null || doc.print.author_name === name ? doc : { ...doc, print: { ...doc.print, author_name: name } };

/** A serialised document credited to `name`; unchanged (the same string) when it already is, or with no name. */
export const withAuthorName = (text: string, name: string | null): string => {
	if (name === null) return text;
	return patchText(text, (doc) => docWithAuthorName(doc, name));
};

/**
 * The document with a fold (fold.ts) as its `copy_of` and `identical_to`; the same object when it
 * already has it. Only the ids: the page reads the other print's title and author from its document.
 */
export const docWithFold = (doc: PrintDoc, fold: FoldState): PrintDoc => {
	if ((doc.print.copy_of?.id ?? null) === fold.duplicateOf && (doc.print.identical_to?.id ?? null) === fold.identicalTo) return doc;
	const print = { ...doc.print };
	delete print.copy_of;
	delete print.identical_to;
	return {
		...doc,
		print: {
			...print,
			...(fold.duplicateOf ? { copy_of: { id: fold.duplicateOf } } : {}),
			...(fold.identicalTo ? { identical_to: { id: fold.identicalTo } } : {})
		}
	};
};

/** `docWithFold` on a serialised document; the same string when it already has the fold. */
export const withFold = (text: string, fold: FoldState): string => patchText(text, (doc) => docWithFold(doc, fold));

/** The document listing `sources` (`docSources`'s, undefined for none); the same object when it already does. */
export const docWithSources = (doc: PrintDoc, sources: readonly PrintSource[] | undefined): PrintDoc => {
	if (JSON.stringify(doc.print.sources ?? null) === JSON.stringify(sources ?? null)) return doc;
	const print = { ...doc.print };
	delete print.sources;
	return { ...doc, print: sources ? { ...print, sources: [...sources] } : print };
};

/** `docWithSources` on a serialised document; the same string when it already lists them. */
export const withSources = (text: string, sources: readonly PrintSource[] | undefined): string =>
	patchText(text, (doc) => docWithSources(doc, sources));

const patchText = (text: string, patch: (doc: PrintDoc) => PrintDoc): string => {
	const doc = JSON.parse(text) as PrintDoc;
	const next = patch(doc);
	return next === doc ? text : JSON.stringify(next);
};

export const parsePrintDoc = (text: string | null): PrintDoc | null => {
	if (text === null) return null;
	try {
		const doc = JSON.parse(text) as PrintDoc;
		return doc.v === PRINT_DOC_VERSION ? doc : null;
	} catch {
		return null;
	}
};

/** The print page's data: its R2 document, or null when the print isn't on the site. */
export const readPrintDoc = async (bucket: R2Bucket, id: string): Promise<PrintDoc | null> =>
	parsePrintDoc((await (await bucket.get(analysisKey(id)))?.text()) ?? null);
