-- Which prints are the same print, whatever site they came from (src/lib/server/pipeline/identity.ts,
-- admit.ts). Written with a print's own rows on every ingest; filled for prints ingested before this
-- migration by the next backfill, which writes only these rows for them (IngestOutcome 'identified').

-- Every place a print was posted: factorioprints (site id = the print id), uploads, other sites. A
-- print's credit goes to its live source with the earliest `uploaded_at` (first upload wins); its id
-- (URL) is the first ingestion's and never changes.
CREATE TABLE print_sources (
	-- 'factorioprints' | 'upload' | 'factoriobin' | 'codex' | 'fprints' (src/lib/print-id.ts).
	site TEXT NOT NULL,
	-- The site's own id: factorioprints' 20-character id, an upload's 10 characters, …
	site_id TEXT NOT NULL,
	print_id TEXT NOT NULL,
	-- The print's page on that site.
	url TEXT NOT NULL,
	-- When the site says it was posted (factorioprints: `createdDate`), unix ms; NULL when it doesn't say.
	uploaded_at INTEGER,
	-- The site's last edit (factorioprints: `lastUpdatedDate`), unix ms.
	updated_at INTEGER,
	-- When we first ingested it, unix ms.
	first_seen INTEGER NOT NULL,
	-- When the site stopped having it (sourceGone), unix ms; NULL while live. A source that comes back is live again.
	gone_at INTEGER,
	PRIMARY KEY (site, site_id)
) WITHOUT ROWID;
CREATE INDEX print_sources_print ON print_sources (print_id);

-- Content hashes of every version a print has had (an author's edit adds rows, so copies of the old
-- version still match). kind: 'print' and 'print_layout' (the whole print, page_path ''), 'page' and
-- 'page_layout' (each blueprint page, by book path, as the analysis' nodes). Exact hashes ('print',
-- 'page') can join prints and be blocked (`removal_blocks` 'sha256'); layout hashes only ever suggest.
CREATE TABLE print_fingerprints (
	kind TEXT NOT NULL,
	-- Hex SHA-256.
	sha256 TEXT NOT NULL,
	print_id TEXT NOT NULL,
	page_path TEXT NOT NULL,
	-- Entities + tiles: a match joins prints only from JOIN_MIN_SIZE (50) up (admit.ts).
	size INTEGER NOT NULL,
	-- Unix ms.
	first_seen INTEGER NOT NULL,
	-- 1 for the print's content as last ingested, 0 for earlier versions.
	current INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (kind, sha256, print_id, page_path)
) WITHOUT ROWID;
CREATE INDEX print_fingerprints_print ON print_fingerprints (print_id, kind);

-- The soft fold (fold.ts), within one author: a later exact copy (whole print, at least 50 entities
-- and tiles) by the same author (same site, same author id) of an earlier live print keeps its page,
-- but stays out of search, landing pages and the sitemap, and its page points at the earlier one
-- (canonical link, "Same blueprint as …"): `duplicate_of`. A copy by anyone else stays fully visible
-- with a note, "Identical to … posted earlier": `identical_to`, the group's earliest print. Both NULL
-- for every other print; kept by re-ingests (upsert never writes them), recomputed per group by fold.ts.
ALTER TABLE prints ADD COLUMN duplicate_of TEXT;
ALTER TABLE prints ADD COLUMN identical_to TEXT;
CREATE INDEX prints_duplicates ON prints (duplicate_of) WHERE duplicate_of IS NOT NULL;
CREATE INDEX prints_identical ON prints (identical_to) WHERE identical_to IS NOT NULL;

-- A removal approval's choice of identical copies to take down with the print (/admin/reports): their
-- ids as a JSON array, read again by a takedown run that stopped part-way, after the print's own
-- fingerprints (which found them) have gone. NULL: none.
ALTER TABLE reports ADD COLUMN copies TEXT;
