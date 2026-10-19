-- Precomputed viewer files: the VIEWER_VERSION
-- that wrote a print's `viewer/<id>/` files in R2. NULL means none were written (rows from before
-- this migration, and failed records), so the next `bun run ingest` builds them without re-analysing.
ALTER TABLE ingest_state ADD COLUMN viewer_version INTEGER;
