-- Mirror bytes behind the prints a run has written. R2 objects and bytes grow with record size,
-- not print count, and a `--limit` sample spread by size over-represents big books, so full-run
-- projections scale R2 by bytes (r2 per source byte × the mirror's total, `options.corpusBytes`).
ALTER TABLE pipeline_runs ADD COLUMN source_bytes INTEGER NOT NULL DEFAULT 0;
