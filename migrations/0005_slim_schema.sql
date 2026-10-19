-- Slim schema: about 13 rows per print instead of ~170.
-- The full analysis moves to R2 (`analysis/<id>.json`); D1 keeps only what search needs.
-- Everything here is rebuilt from the raw archive, so the old tables are dropped, not migrated:
-- clearing ingest_state makes the next `bun run ingest` re-analyse every print.

DROP TABLE IF EXISTS print_search;
DROP TABLE IF EXISTS print_items;
DROP TABLE IF EXISTS print_entities;
DROP TABLE IF EXISTS print_recipes;
DROP TABLE IF EXISTS print_nodes;
DROP TABLE IF EXISTS print_analysis;
DROP TABLE IF EXISTS prints;
DELETE FROM ingest_state;

-- One row per print: what a search result card shows, plus the sort keys.
CREATE TABLE prints (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	source_url TEXT NOT NULL,
	title TEXT NOT NULL,
	author_id TEXT,
	author_name TEXT,
	favorites INTEGER NOT NULL DEFAULT 0,
	image_id TEXT,
	image_type TEXT,
	created_at INTEGER,
	updated_at INTEGER,
	raw_key TEXT NOT NULL,
	raw_sha256 TEXT NOT NULL,
	ingested_at INTEGER NOT NULL,
	analyzer_version INTEGER NOT NULL,
	root_kind TEXT NOT NULL,
	game_version TEXT,
	game_major INTEGER,
	blueprint_count INTEGER NOT NULL,
	entity_count INTEGER NOT NULL,
	requires_space_age INTEGER NOT NULL,
	uses_circuits INTEGER NOT NULL,
	uses_trains INTEGER NOT NULL,
	-- Small JSON arrays for the card: product signals, versions, planets, mods.
	outputs TEXT NOT NULL DEFAULT '[]',
	claimed_versions TEXT NOT NULL DEFAULT '[]',
	planets TEXT NOT NULL DEFAULT '[]',
	mods TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX prints_favorites ON prints (favorites DESC);
CREATE INDEX prints_updated ON prints (updated_at DESC);

-- What each print makes and takes, for exact "Makes" facet counts on filtered searches.
-- Filtering itself goes through the FTS `facets` tokens.
CREATE TABLE print_items (
	print_id TEXT NOT NULL REFERENCES prints (id) ON DELETE CASCADE,
	role TEXT NOT NULL CHECK (role IN ('output', 'input')),
	item TEXT NOT NULL,
	PRIMARY KEY (print_id, role, item)
) WITHOUT ROWID;

-- Text search and every filter in one index. `facets` holds keyword tokens such as
-- makes_item_automation_science_pack, takes_item_iron_plate, v_2_0, sa_yes, uses_trains,
-- tag_general_tileable, planet_vulcanus and mod_krastorio2; `tokenchars '_'` keeps each whole.
CREATE VIRTUAL TABLE print_search USING fts5 (
	print_id UNINDEXED,
	title,
	description,
	labels,
	entities,
	recipes,
	nicknames,
	facets,
	tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
);

-- Sidebar counts for the unfiltered search page, rebuilt after each ingest or sync.
CREATE TABLE facet_counts (
	kind TEXT NOT NULL,
	value TEXT NOT NULL,
	n INTEGER NOT NULL,
	PRIMARY KEY (kind, value)
) WITHOUT ROWID;

-- Small key/value state, e.g. sync_version for cache keys.
CREATE TABLE meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
