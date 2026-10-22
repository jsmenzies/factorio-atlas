-- Game-render runs and their queue. Renders are made offline on the machine that has the sprite
-- atlases (`bun run render`), which fills these tables in the local database; /admin/render shows
-- them. Deployed stages carry the tables empty.

-- One row per `bun run render` run. The runner rewrites its row every few seconds (heartbeat, live
-- counts, rate, ETA) and reads `control`, which /admin/render sets, to pause, resume or stop.
CREATE TABLE render_runs (
	id TEXT PRIMARY KEY,
	-- Machine name.
	host TEXT NOT NULL,
	-- e.g. 'mirror@96d6afa' (the clone's commit).
	source TEXT NOT NULL,
	-- JSON: {assets, quality, effort, levels, workers, limit, ids, force}.
	options TEXT NOT NULL,
	-- 'crashed' is never written by the runner: readers infer it from a stale heartbeat.
	state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'paused', 'stopping', 'finished', 'stopped', 'failed')),
	-- Set by the admin page, cleared by the runner once acted on.
	control TEXT CHECK (control IN ('pause', 'resume', 'stop')),
	-- Pages this run will look at, and how many it has finished with (every outcome).
	total INTEGER NOT NULL DEFAULT 0,
	done INTEGER NOT NULL DEFAULT 0,
	-- Outcomes, summing to `done`: rendered now, already rendered with the same input_key, skipped
	-- (modded, empty, not 2.0+), failed after its last attempt.
	rendered INTEGER NOT NULL DEFAULT 0,
	unchanged INTEGER NOT NULL DEFAULT 0,
	skipped INTEGER NOT NULL DEFAULT 0,
	failed INTEGER NOT NULL DEFAULT 0,
	-- Files and bytes written by this run (unique tiles only).
	files INTEGER NOT NULL DEFAULT 0,
	bytes INTEGER NOT NULL DEFAULT 0,
	-- Pages/s over the last 5 minutes, and seconds left, computed by the runner.
	rate REAL,
	eta_seconds INTEGER,
	-- Unix ms. updated_at is the heartbeat.
	started_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	finished_at INTEGER,
	-- Why a run ended in 'failed'.
	error TEXT
);

CREATE INDEX render_runs_started ON render_runs (started_at DESC);

-- One row per blueprint page: the durable queue. A page whose input_key matches a 'done' row is
-- never rendered again; changing the page, the sprite assets or the render settings changes the key.
CREATE TABLE render_jobs (
	print_id TEXT NOT NULL,
	-- Book path as in the viewer files: '' for a lone blueprint, else '3', '3/1', …
	path TEXT NOT NULL,
	-- For the admin page, so it needs no other table.
	title TEXT,
	label TEXT,
	game_version TEXT,
	entities INTEGER NOT NULL DEFAULT 0,
	-- sha256 of the page's blueprint JSON + asset id + render settings version.
	input_key TEXT NOT NULL,
	-- 'rendering' rows without a live run (stale heartbeat) go back to 'pending' when a run starts.
	status TEXT NOT NULL CHECK (status IN ('pending', 'rendering', 'done', 'failed', 'skipped')),
	-- Skip reason ('modded: ee-infinity-loader, …', 'empty', 'pre-2.0') or the last error.
	reason TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	-- The run that last touched the row.
	run_id TEXT,
	-- Results of the last successful render: files and bytes (unique), render ms, the overview
	-- file relative to the print (`<base>.avif`) and the stamp image URLs carry (`?v=`).
	files INTEGER,
	bytes INTEGER,
	ms INTEGER,
	overview TEXT,
	stamp TEXT,
	-- Unix ms.
	queued_at INTEGER NOT NULL,
	started_at INTEGER,
	finished_at INTEGER,
	-- Set by the uploader once the page's files are in the deployed RENDERS bucket (later).
	uploaded_at INTEGER,
	PRIMARY KEY (print_id, path)
) WITHOUT ROWID;

CREATE INDEX render_jobs_status ON render_jobs (status, finished_at DESC);
