-- Add a column for community nicknames ("red science", "gc", "prod 3") of everything a
-- print makes, takes or contains. FTS5 can't add columns, so rebuild the table; re-ingest
-- (`bun run ingest --from-disk`) refills it.
DROP TABLE print_search;

CREATE VIRTUAL TABLE print_search USING fts5 (
	print_id UNINDEXED,
	title,
	description,
	labels,
	entities,
	recipes,
	nicknames,
	tokenize = 'porter unicode61'
);
