-- The most-favourited prints, rendered as well as every print with a 2.0+ page (`bun run render
-- --top N`), and checks of the mirror clone for records that changed since a run looked at them.
-- Like 0010–0013, written in the local database by the render scripts; deployed stages carry the
-- tables empty.

-- Every print that has been in a top-N list. A print in this table is in the render scope for good,
-- with its pages saved before 2.0 rendered too: a refresh that leaves it out of the top N only sets
-- in_top = 0, so no run removes what was rendered for it.
CREATE TABLE render_favorites (
	print_id TEXT PRIMARY KEY,
	-- numberOfFavorites in the record at the latest refresh.
	favorites INTEGER NOT NULL,
	-- Place by favourites at the latest refresh (1 = most, ties by id); NULL once the record is gone.
	rank INTEGER,
	-- 1 while it is in the latest list's top N.
	in_top INTEGER NOT NULL,
	-- Unix ms: the latest refresh, and the refresh that first put it in a list.
	refreshed_at INTEGER NOT NULL,
	first_added_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX render_favorites_top ON render_favorites (in_top, rank);

-- Prints whose record file in the source differs from the stamp render_prints holds (size:mtime
-- when a run last looked at it), or is gone, at the latest check. A check replaces every row. A row
-- counts only while checked_at is after render_prints.checked_at: a run that looks at the print
-- again settles it.
CREATE TABLE render_source_changes (
	print_id TEXT PRIMARY KEY,
	-- The file's stamp at the check; NULL: no such file any more.
	stamp TEXT,
	checked_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Small JSON documents for /admin/render: 'favorites' (the latest top-N refresh: n, source, prints
-- read, when, how long) and 'source-check' (the latest check: prints compared, changed, gone, new).
CREATE TABLE render_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL
) WITHOUT ROWID;
