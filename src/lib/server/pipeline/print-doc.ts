/**
 * The print page's whole data source: one JSON document per print in R2, so a print page
 * never queries D1.
 */
import type { Site } from '#lib/print-id.js';
import type { PrintAnalysis } from './analyze';
import type { FoldState } from './fold';
import type { FirebaseRecord } from './record';
import { toEpochMs } from './record';

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
		/** Only on a later exact copy by the same author (the soft fold, fold.ts): their earlier print. */
		copy_of?: { id: string };
		/** Only on an exact copy by someone else (fold.ts): the earliest print of that content. */
		identical_to?: { id: string };
	};
	analysis: PrintAnalysis;
}

/** The print as its page gets it: the description arrives as sanitised HTML, so the Markdown stays on the server. */
export type PagePrint = Omit<PrintDoc['print'], 'description_md'>;

export const toPrintDoc = (id: string, sourceUrl: string, r: FirebaseRecord, analysis: PrintAnalysis): PrintDoc => ({
	v: PRINT_DOC_VERSION,
	print: {
		id,
		title: r.title,
		author_id: r.author?.userId ?? r.authorId ?? null,
		author_name: r.author?.displayName ?? r.source?.author?.name ?? null,
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

/** A serialised document credited to `name`; unchanged (the same string) when it already is, or with no name. */
export const withAuthorName = (text: string, name: string | null): string => {
	if (name === null) return text;
	const doc = JSON.parse(text) as PrintDoc;
	return doc.print.author_name === name ? text : JSON.stringify({ ...doc, print: { ...doc.print, author_name: name } });
};

/**
 * A serialised document with a fold (fold.ts) as its `copy_of` and `identical_to`; the same string when
 * it already has it. Only the ids: the page reads the other print's title and author from its document.
 */
export const withFold = (text: string, fold: FoldState): string => {
	const doc = JSON.parse(text) as PrintDoc;
	if ((doc.print.copy_of?.id ?? null) === fold.duplicateOf && (doc.print.identical_to?.id ?? null) === fold.identicalTo) return text;
	const print = { ...doc.print };
	delete print.copy_of;
	delete print.identical_to;
	return JSON.stringify({
		...doc,
		print: {
			...print,
			...(fold.duplicateOf ? { copy_of: { id: fold.duplicateOf } } : {}),
			...(fold.identicalTo ? { identical_to: { id: fold.identicalTo } } : {})
		}
	});
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
