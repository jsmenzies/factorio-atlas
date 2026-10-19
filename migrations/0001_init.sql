-- One row per source print (a factorioprints.com record).
CREATE TABLE prints (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	source_url TEXT NOT NULL,
	title TEXT NOT NULL,
	description_md TEXT NOT NULL,
	author_id TEXT,
	author_name TEXT,
	tags TEXT NOT NULL DEFAULT '[]',
	favorites INTEGER NOT NULL DEFAULT 0,
	image_id TEXT,
	image_type TEXT,
	created_at INTEGER,
	updated_at INTEGER,
	raw_key TEXT NOT NULL,
	raw_sha256 TEXT NOT NULL,
	ingested_at INTEGER NOT NULL
);

-- Derived facts about the whole print. `summary` holds the full analyzer output
-- so new facets can be backfilled without re-downloading.
CREATE TABLE print_analysis (
	print_id TEXT PRIMARY KEY REFERENCES prints (id) ON DELETE CASCADE,
	analyzer_version INTEGER NOT NULL,
	root_kind TEXT NOT NULL,
	game_version TEXT,
	game_major INTEGER,
	blueprint_count INTEGER NOT NULL,
	entity_count INTEGER NOT NULL,
	tile_count INTEGER NOT NULL,
	requires_space_age INTEGER NOT NULL,
	uses_quality INTEGER NOT NULL,
	uses_circuits INTEGER NOT NULL,
	uses_trains INTEGER NOT NULL,
	mods TEXT NOT NULL DEFAULT '[]',
	planets TEXT NOT NULL DEFAULT '[]',
	summary TEXT NOT NULL,
	analyzed_at INTEGER NOT NULL
);

-- Every blueprintable inside the print. `path` is the book index path, e.g. "" for
-- the root, "3" or "3/1" for nested pages.
CREATE TABLE print_nodes (
	print_id TEXT NOT NULL REFERENCES prints (id) ON DELETE CASCADE,
	path TEXT NOT NULL,
	kind TEXT NOT NULL,
	label TEXT,
	description TEXT,
	game_version TEXT,
	entity_count INTEGER NOT NULL,
	width INTEGER,
	height INTEGER,
	icons TEXT NOT NULL DEFAULT '[]',
	PRIMARY KEY (print_id, path)
);

CREATE TABLE print_entities (
	print_id TEXT NOT NULL REFERENCES prints (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (print_id, name)
);
CREATE INDEX print_entities_name ON print_entities (name);

CREATE TABLE print_recipes (
	print_id TEXT NOT NULL REFERENCES prints (id) ON DELETE CASCADE,
	recipe TEXT NOT NULL,
	machines INTEGER NOT NULL,
	PRIMARY KEY (print_id, recipe)
);
CREATE INDEX print_recipes_recipe ON print_recipes (recipe);

CREATE VIRTUAL TABLE print_search USING fts5 (
	print_id UNINDEXED,
	title,
	description,
	labels,
	entities,
	recipes,
	tokenize = 'porter unicode61'
);
