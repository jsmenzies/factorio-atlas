-- Author names. Most factorioprints records carry only the author's user id; the name lives in
-- Firebase's public `users/<id>/displayName`. `bun run authors --stage …` fills this table (names
-- from records first, then Firebase for the rest) and puts the names on prints that lack one; the
-- ingest seeds it with every record's own name and reads it for prints whose record has none.
CREATE TABLE authors (
	author_id TEXT PRIMARY KEY,
	-- NULL: Firebase has no name for this id (kept, so it isn't asked again).
	display_name TEXT,
	-- 'record' (a print's own record) or 'firebase'.
	source TEXT NOT NULL,
	-- Unix ms.
	fetched_at INTEGER NOT NULL
) WITHOUT ROWID;

-- The search index gains an `author` column, so typed text finds an author's prints, and a
-- `by_<author id>` facet token for the `?author=` filter. FTS5 tables can't add columns, so the
-- index is rebuilt from the old one; the author's name comes from `prints`.
CREATE VIRTUAL TABLE print_search_next USING fts5 (
	print_id UNINDEXED,
	title,
	description,
	labels,
	entities,
	recipes,
	nicknames,
	author,
	facets,
	tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
);
-- Author ids are 28 letters and digits, so lower() gives the same token as `slug` in repository.ts.
INSERT INTO print_search_next (print_id, title, description, labels, entities, recipes, nicknames, author, facets)
SELECT s.print_id, s.title, s.description, s.labels, s.entities, s.recipes, s.nicknames, coalesce(p.author_name, ''),
	CASE WHEN p.author_id IS NULL THEN s.facets ELSE 'by_' || lower(p.author_id) || ' ' || s.facets END
FROM print_search s LEFT JOIN prints p ON p.id = s.print_id;
DROP TABLE print_search;
ALTER TABLE print_search_next RENAME TO print_search;

INSERT INTO authors (author_id, display_name, source, fetched_at)
SELECT author_id, max(author_name), 'record', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM prints WHERE author_id IS NOT NULL AND author_name IS NOT NULL GROUP BY author_id;
