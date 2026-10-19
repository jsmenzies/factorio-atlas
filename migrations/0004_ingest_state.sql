-- What the pipeline last did with each source record, so re-runs (backfill, daily sync,
-- re-analysis) skip work that wouldn't change anything. Kept apart from `prints`: a print
-- that fails to decode gets a row here and nothing on the site.
CREATE TABLE ingest_state (
	print_id TEXT PRIMARY KEY,
	-- sha256 of the sanitised record without numberOfFavorites: favourites churn daily.
	content_sha256 TEXT NOT NULL,
	-- 'ok' (analysed and stored) or 'failed' (couldn't parse or decode; skipped until the content changes).
	status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
	reason TEXT,
	analyzer_version INTEGER,
	game_data_version TEXT,
	favorites INTEGER NOT NULL DEFAULT 0,
	checked_at INTEGER NOT NULL
);

CREATE INDEX ingest_state_status ON ingest_state (status);
