-- Which prints have a game render in this stage's RENDERS bucket, for the search page's "Only prints
-- with a render" filter. Written by `bun run render:flags --stage …` from what the render runs
-- uploaded (render_uploads in the machine's local database), not by the backfill, so a re-ingest
-- never loses it: the print's FTS row gets the `render_yes` facet token whenever a row exists here
-- (repository.ts), and the sync patches the FTS rows of prints it sets or unsets. A row may name a
-- print that isn't ingested yet; the backfill picks it up when it is.
CREATE TABLE print_renders (
	print_id TEXT PRIMARY KEY,
	-- Pages listed in the print's remote index.json.
	pages INTEGER NOT NULL,
	-- Unix ms.
	updated_at INTEGER NOT NULL
) WITHOUT ROWID;
