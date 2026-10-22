-- Deleting render files from a RENDERS bucket after a grace period (`bun run render --upload`).
-- Like 0010 and 0011, filled in the local database by the runner; deployed stages carry it empty.
--
-- A browser or the edge may hold a page's sidecar (cached for minutes) that names files a re-render
-- replaced, so the uploader never deletes them at once: it records each key here, and a later run
-- deletes it once `not_before` has passed and nothing uploaded refers to it any more. A key that is
-- uploaded or used again in the meantime loses its row.
CREATE TABLE render_deletes (
	-- 'local' (the miniflare bucket) or 'prod'.
	target TEXT NOT NULL,
	-- The bucket key, `<print id>/<file>`.
	key TEXT NOT NULL,
	print_id TEXT NOT NULL,
	-- Unix ms: not deleted before then.
	not_before INTEGER NOT NULL,
	-- 'replaced', 'unused', 'page removed'.
	reason TEXT NOT NULL,
	queued_at INTEGER NOT NULL,
	PRIMARY KEY (target, key)
) WITHOUT ROWID;

CREATE INDEX render_deletes_print ON render_deletes (target, print_id);
CREATE INDEX render_deletes_due ON render_deletes (target, not_before);

-- Deletions waiting in render_deletes for the run's target, rewritten with the heartbeat.
ALTER TABLE render_runs ADD COLUMN upload_deletes_pending INTEGER NOT NULL DEFAULT 0;
