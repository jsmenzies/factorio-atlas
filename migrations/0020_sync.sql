-- `bun run sync` (scripts/sync.ts) and the admin Overview: one update brings everything up to date
-- with the print sources (fetch, ingest, authors, screenshots, renders). Like the render tables,
-- written in the local database on the machine that renders; deployed stages carry them empty.

-- One row per update. The runner writes every column but `control` with its heartbeat; the
-- Overview sets `control` ('stop': finish the current step, start no more; 'quit': end it at once).
-- `steps` is a JSON array, one entry per step in order (src/lib/sync.ts: SyncStep), with its status,
-- times and summary.
CREATE TABLE sync_runs (
	id TEXT PRIMARY KEY,
	state TEXT NOT NULL,
	control TEXT,
	-- Where the steps write: 'prod', or 'local' for trying an update out.
	stage TEXT NOT NULL,
	-- The settings the update ran with, the process id and its log file name (JSON).
	options TEXT NOT NULL,
	-- Each print source's cursor before and after the fetch (src/lib/sync.ts: SourceRun), JSON.
	sources TEXT NOT NULL DEFAULT '[]',
	steps TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	finished_at INTEGER,
	error TEXT
);
CREATE INDEX sync_runs_started ON sync_runs (started_at);

-- Small JSON documents the Overview reads: 'settings' (saved from the page; defaults when missing),
-- 'plan' (what an update would do, from the last check of the sources), 'figures' (the site's counts
-- on the stage, read at the end of each update), 'imgur-recheck' and 'accept' (a held-back source
-- update to fetch anyway).
CREATE TABLE sync_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
