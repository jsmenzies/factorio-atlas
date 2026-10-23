-- Page views per print over the last 30 days, for the search page's "Popular" sort. The views
-- themselves are Analytics Engine data points (src/routes/prints/[id]/view); `bun run views:sync`
-- totals them and writes the counts here. The ingest's upsert names its columns, so a re-ingest
-- keeps the count; a print ingested after the last sync shows 0 until the next one.
ALTER TABLE prints ADD COLUMN views_30d INTEGER NOT NULL DEFAULT 0;
-- The unfiltered "Popular" order walks this index; prints with equal views fall back to favourites.
CREATE INDEX prints_views ON prints (views_30d DESC, favorites DESC);
