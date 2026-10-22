-- Uploading renders to a RENDERS bucket (`bun run render --upload local|prod`), and batches of prints
-- (`--next N`). Like 0010, these tables are filled in the local database by the runner; deployed
-- stages carry them empty.

-- Upload progress per run, rewritten with the heartbeat. NULL target: the run uploads nothing.
ALTER TABLE render_runs ADD COLUMN upload_target TEXT;
-- Pages whose files and index entry went up in this run, the objects put (tiles, overviews, page
-- data, sidecars; index rewrites not counted) and their bytes, and objects deleted.
ALTER TABLE render_runs ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_runs ADD COLUMN upload_files INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_runs ADD COLUMN upload_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_runs ADD COLUMN upload_deleted INTEGER NOT NULL DEFAULT 0;
-- Rendered pages still waiting to go up, and pages whose upload failed and waits for a retry.
ALTER TABLE render_runs ADD COLUMN uploads_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_runs ADD COLUMN upload_failed INTEGER NOT NULL DEFAULT 0;
-- The latest upload error, kept after it clears (for the admin page).
ALTER TABLE render_runs ADD COLUMN upload_error TEXT;

-- What each target bucket holds, per page: the version of the page whose files are there. The
-- remote index.json lists exactly the pages with a stamp here (whose rows still exist), so it
-- never names a page whose files aren't up.
CREATE TABLE render_uploads (
	-- 'local' (the miniflare bucket) or 'prod'.
	target TEXT NOT NULL,
	print_id TEXT NOT NULL,
	path TEXT NOT NULL,
	-- Sidecar stamp and renderedAt of the uploaded version; NULL stamp: nothing uploaded yet (only an error).
	stamp TEXT,
	rendered_at TEXT,
	-- 1 when the files on disk changed without a new stamp (page data rewritten): upload again.
	stale INTEGER NOT NULL DEFAULT 0,
	-- Objects put for this version and their bytes (tiles already in the bucket not counted).
	files INTEGER,
	bytes INTEGER,
	-- Unix ms.
	uploaded_at INTEGER,
	-- The last failed attempt, cleared by a successful one.
	error TEXT,
	failed_at INTEGER,
	PRIMARY KEY (target, print_id, path)
) WITHOUT ROWID;

-- Every print a run has looked at, so `--next N` can rule out prints with nothing left to do
-- without decoding them again. `stamp` is the source file's size and mtime when it was looked at;
-- a different stamp means the record changed and is looked at again.
CREATE TABLE render_prints (
	print_id TEXT PRIMARY KEY,
	stamp TEXT,
	-- 1 when it has a page saved in 2.0+ (it then has render_jobs rows), else 0.
	modern INTEGER NOT NULL,
	checked_at INTEGER NOT NULL
) WITHOUT ROWID;
