-- Prints progress, render sizes per print and upload speed for /admin/render. Like 0010–0012,
-- written in the local database by `bun run render` with its heartbeat; deployed stages carry the
-- columns empty.

-- Prints the run works on: a batch's picks (`--next N`), every id given (`--ids`), else every print
-- with a 2.0+ page. Of those, prints whose every page reached a final state in this run (rendered,
-- unchanged, skipped or failed), and prints with a page rendered (drawn) in this run.
ALTER TABLE render_runs ADD COLUMN prints_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_runs ADD COLUMN prints_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_runs ADD COLUMN prints_rendered INTEGER NOT NULL DEFAULT 0;

-- Upload speed, measured by the uploader over a sliding window: bytes/s and files/s put over the
-- last minute, pages/s up over the last 5 minutes (the window of `rate`, so the two compare).
-- NULL: the run uploads nothing, or nothing has gone up yet.
ALTER TABLE render_runs ADD COLUMN upload_rate_bytes REAL;
ALTER TABLE render_runs ADD COLUMN upload_rate_files REAL;
ALTER TABLE render_runs ADD COLUMN upload_rate_pages REAL;
