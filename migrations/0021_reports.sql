-- Reports from visitors for an admin to decide at /admin/reports: removal requests from the print page's
-- "Request removal" form (kind 'removal', subject a print), and later other reports (uploads: about an
-- image or an account). One row per report; the admin decides a subject's open reports together. Nothing
-- happens to anything until one is approved.
CREATE TABLE reports (
	-- Random (newReportId).
	id TEXT PRIMARY KEY,
	-- 'removal'; more kinds come later (src/lib/reports.ts).
	kind TEXT NOT NULL,
	-- What the report is about: 'print' (a print id), 'image' (a screenshot's image id) or 'account' (a user id).
	subject_kind TEXT NOT NULL,
	subject_id TEXT NOT NULL,
	-- The print concerned, when there is one: the subject itself, or the print an image was reported on.
	print_id TEXT,
	-- One of the kind's reasons (src/lib/reports.ts).
	reason TEXT NOT NULL,
	-- Free text from the form, capped (src/lib/reports.ts). Cleared 30 days after the decision.
	details TEXT,
	-- How to reach the reporter, if they gave one. Cleared 30 days after the decision.
	contact TEXT,
	-- The signed-in account that sent it, if any.
	reporter_user_id TEXT,
	-- 'open' | 'approved' | 'rejected'.
	status TEXT NOT NULL DEFAULT 'open',
	-- Unix ms.
	created_at INTEGER NOT NULL,
	decided_at INTEGER,
	-- Who decided: the Access email when deployed, 'dev' under vite dev.
	decided_by TEXT,
	-- The admin's note on the decision.
	note TEXT,
	-- When an approved report's action finished: for a removal, every block written, every file deleted and
	-- the edge cache purged. NULL while approved means it must be run again.
	applied_at INTEGER,
	-- While an approved report isn't applied: what the edge cache still has to forget (JSON
	-- { prefixes, urls }, kept across retries, since a retry can't list files already deleted) and the
	-- last error.
	pending_purge TEXT,
	apply_error TEXT
);
CREATE INDEX reports_status ON reports (status, created_at);
CREATE INDEX reports_subject ON reports (subject_kind, subject_id, status);
-- The decided list and the 30-day clearing of contacts and details.
CREATE INDEX reports_decided ON reports (decided_at);

-- What must never be ingested or shown again, written when a removal is approved. Every ingest path
-- checks it: the factorioprints pipeline (`print` and `source` blocks), renders and screenshot copies
-- (from a local copy, `bun run removals`), and later other sites and uploads (`source`, `sha256`).
-- Deleting a print's rows undoes its removal: the next backfill ingests it again.
CREATE TABLE removal_blocks (
	-- 'print': our print id; 'source': '<site>:<site id>', e.g. 'factorioprints:-KYp…'; 'sha256': the
	-- canonical hash of a blueprint page or book; 'image': a screenshot's image id.
	kind TEXT NOT NULL,
	value TEXT NOT NULL,
	-- The removed print the block came from.
	print_id TEXT NOT NULL,
	-- The approved report, if any (NULL when an admin removed the print directly).
	report_id TEXT,
	-- Unix ms.
	created_at INTEGER NOT NULL,
	PRIMARY KEY (kind, value)
) WITHOUT ROWID;
CREATE INDEX removal_blocks_print ON removal_blocks (print_id);

-- The database's own guard: no `prints` row for a blocked print, whichever code writes it (an ingest that
-- checked the blocks before an approval landed mid-run). The whole batch fails, so none of the print's
-- rows are written; the pipeline answers 'removed' and deletes the files it had put in R2.
CREATE TRIGGER prints_not_removed BEFORE INSERT ON prints
WHEN EXISTS (SELECT 1 FROM removal_blocks WHERE kind = 'print' AND value = NEW.id)
BEGIN
	SELECT RAISE(ABORT, 'print removed on request');
END;

-- Prints whose data was deleted (purgePrintData), so the machine that renders can sweep its own copies
-- (`bun run removals` reads them from prod) and a print page can answer 410 rather than 404.
-- 'takedown': an approved removal (it comes with blocks); 'gone': deleted by its owner or gone from
-- every source (no blocks; the print's next ingest deletes the row, as it is back).
CREATE TABLE print_tombstones (
	print_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	-- Unix ms.
	at INTEGER NOT NULL
) WITHOUT ROWID;

-- Local D1 only (empty on deployed stages): the deleted prints `bun run removals` has swept from this
-- machine, per stage whose tombstones it followed, so later runs sweep only new ones.
CREATE TABLE removal_sweeps (
	stage TEXT NOT NULL,
	print_id TEXT NOT NULL,
	-- The tombstone's `at` when swept: a newer one (deleted again) is swept again.
	tomb_at INTEGER NOT NULL,
	-- Unix ms.
	swept_at INTEGER NOT NULL,
	PRIMARY KEY (stage, print_id)
) WITHOUT ROWID;
