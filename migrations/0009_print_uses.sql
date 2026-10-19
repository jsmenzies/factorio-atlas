-- "Built with" search (`?uses=entity:foundry`). Filtering goes through the FTS `facets` tokens
-- (uses_entity_<name>, written for every entity); this table holds only the curated buildings
-- (src/lib/server/pipeline/buildings.ts), for exact "Built with" counts on filtered searches.
-- Unfiltered counts are facet_counts kind 'uses', rebuilt by rebuildFacets.
CREATE TABLE print_uses (
	print_id TEXT NOT NULL REFERENCES prints (id) ON DELETE CASCADE,
	-- "entity:<name>", the ?uses= value.
	entity TEXT NOT NULL,
	PRIMARY KEY (print_id, entity)
) WITHOUT ROWID;

-- INDEX_VERSION (repository.ts) of a print's D1 rows. NULL (every row from before this migration)
-- makes the next run rewrite just the D1 rows from the R2 analysis document: no re-analysis, no
-- viewer files.
ALTER TABLE ingest_state ADD COLUMN index_version INTEGER;

-- Runs count prints whose D1 rows were rewritten for a new INDEX_VERSION (IngestOutcome 'reindexed').
ALTER TABLE pipeline_runs ADD COLUMN reindexed INTEGER NOT NULL DEFAULT 0;
