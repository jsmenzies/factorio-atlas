-- One row per pipeline run (backfill, daily sync, re-analysis), in the database the run fills.
-- The runner rewrites its row every few seconds (a heartbeat with live counts, rate and ETA) and
-- reads `control`, which /admin/pipeline sets, to pause, resume or stop. Failed prints themselves
-- are in ingest_state (status 'failed', checked_at within the run).
CREATE TABLE pipeline_runs (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('backfill', 'sync', 'reanalyze')),
	-- Where the data goes: 'local', 'dev' or 'prod'.
	stage TEXT NOT NULL,
	-- Machine name, or 'github-actions'.
	host TEXT NOT NULL,
	-- e.g. 'mirror@96d6afa'.
	source TEXT NOT NULL,
	-- JSON: {limit, ids, concurrency, force, retryFailed}.
	options TEXT NOT NULL,
	-- 'crashed' is never written by the runner: readers infer it from a stale heartbeat.
	state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'paused', 'stopping', 'finished', 'stopped', 'failed')),
	-- Set by the admin page, cleared by the runner once acted on.
	control TEXT CHECK (control IN ('pause', 'resume', 'stop')),
	-- Prints this run will look at, and how many it has finished with (every outcome).
	total INTEGER NOT NULL DEFAULT 0,
	done INTEGER NOT NULL DEFAULT 0,
	-- Outcomes (IngestOutcome.status), summing to `done`.
	analysed INTEGER NOT NULL DEFAULT 0,
	viewer INTEGER NOT NULL DEFAULT 0,
	unchanged INTEGER NOT NULL DEFAULT 0,
	favorites INTEGER NOT NULL DEFAULT 0,
	failed INTEGER NOT NULL DEFAULT 0,
	skipped_failed INTEGER NOT NULL DEFAULT 0,
	-- JSON {reason prefix: count}, e.g. {"decode": 41, "timeout": 5}.
	failures TEXT NOT NULL DEFAULT '{}',
	-- Real D1 meta.rows_written for the run's print writes, and R2 objects/bytes put.
	rows_written INTEGER NOT NULL DEFAULT 0,
	r2_objects INTEGER NOT NULL DEFAULT 0,
	r2_bytes INTEGER NOT NULL DEFAULT 0,
	-- Computed by the runner so every view agrees: prints/s over the last 5 minutes, and seconds left.
	rate REAL,
	eta_seconds INTEGER,
	-- Unix ms. updated_at is the heartbeat.
	started_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	finished_at INTEGER,
	-- Why a run ended in 'failed'.
	error TEXT
);

CREATE INDEX pipeline_runs_started ON pipeline_runs (started_at DESC);
