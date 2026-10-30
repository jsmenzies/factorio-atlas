-- Prints people upload (src/lib/server/uploads/). An upload is one more source site, `upload`
-- (plans: ingest and delete): its record is a SourceRecord in RAW at `upload/<site id>.json` (the only
-- copy), admitted through the same gate as every other source and ingested by the same pipeline.

-- Images uploaded with a print. The original stays private in RAW (`upload-images/<id>.<ext>`) until an
-- admin approves it; then the screenshots step sizes it under the key `upload.<id>` and the print's
-- `prints.image_id` becomes `upload.<id>`. A rejected image is deleted and blocked (removal_blocks kind
-- 'image'). One row per distinct image: uploads with the same bytes share it.
CREATE TABLE upload_images (
	-- The first 16 hex digits of the image's SHA-256.
	id TEXT PRIMARY KEY,
	-- The full SHA-256, for the image block.
	sha256 TEXT NOT NULL,
	-- From the file's own bytes, never the browser's word: 'png' | 'jpg' | 'webp' | 'gif'.
	ext TEXT NOT NULL CHECK (ext IN ('png', 'jpg', 'webp', 'gif')),
	bytes INTEGER NOT NULL,
	-- The account that sent it first; NULL once that account is deleted. No foreign key: a shared image
	-- outlives the account.
	user_id TEXT,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
	-- Unix ms.
	created_at INTEGER NOT NULL,
	decided_at INTEGER
) WITHOUT ROWID;
-- The admin queue: pending images, oldest first.
CREATE INDEX upload_images_status ON upload_images (status, created_at);

CREATE TABLE uploads (
	-- 'up-' and 10 base62 characters; the 10 are the source's site_id (print_sources: site 'upload').
	print_id TEXT PRIMARY KEY,
	-- No ON DELETE: deleting an account deletes its uploads first, through sourceGone.
	user_id TEXT NOT NULL REFERENCES users (id),
	-- 'processing': stored, not on the site yet: over the Worker's size cap (or the Worker stopped
	--   half-way), so the next sync's Bun ingest admits it from RAW. 'live': admitted and ingested, the
	--   print is at /prints/<print_id>. 'refused': the sync's gate refused a processing upload
	--   (refused_reason); its owner sees why and can edit or delete it. 'failed': the sync couldn't
	--   process it PROCESSING_ATTEMPTS times (failure: the last error); its owner can edit or delete it.
	state TEXT NOT NULL CHECK (state IN ('processing', 'live', 'refused', 'failed')),
	-- 'blocked' | 'undecodable' | 'duplicate' (refused_print_id: the print it copies).
	refused_reason TEXT,
	refused_print_id TEXT,
	-- The sync's tries at a processing upload that failed (storage errors, not refusals), and the last
	-- error. An edit starts again from 0.
	attempts INTEGER NOT NULL DEFAULT 0,
	failure TEXT,
	-- The record's title, for the owner's list while the print isn't live. The description and string
	-- live only in the RAW record.
	title TEXT NOT NULL,
	-- The exchange string's UTF-8 size, and why a processing upload waits ('string' | 'entities' |
	-- NULL when it only waits for the sync).
	string_bytes INTEGER NOT NULL,
	too_big TEXT,
	image_id TEXT REFERENCES upload_images (id),
	-- The author name in its RAW record and analysis document. After a rename it differs from users.name
	-- until the account page (or, for the rest, the sync) has rewritten them; while any upload shows a
	-- name, no other account can take it (lib/server/auth/users.ts nameTaken).
	shown_name TEXT NOT NULL,
	-- Unix ms. updated_at changes with every edit: the sync's upload adapter fetches records changed
	-- since its last run.
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	live_at INTEGER
) WITHOUT ROWID;
-- The owner's list, and deleting an account's uploads.
CREATE INDEX uploads_user ON uploads (user_id, created_at);
-- The sync's adapter: what changed, and what waits.
CREATE INDEX uploads_updated ON uploads (updated_at);
CREATE INDEX uploads_state ON uploads (state, updated_at);
CREATE INDEX uploads_image ON uploads (image_id);
CREATE INDEX uploads_shown_name ON uploads (shown_name COLLATE NOCASE);

-- Uploads, edits and screenshots counted against an account's daily caps (lib/server/uploads/uploads.ts),
-- per UTC day. Reserved in one statement before anything is written, so parallel requests can't pass a cap
-- (and given back when the gate refuses); never touched when an upload is deleted, so deleting and
-- uploading again doesn't reset the caps. Deleted with the account; the daily cron deletes days before
-- yesterday.
CREATE TABLE upload_quota (
	user_id TEXT NOT NULL,
	-- Days since 1970-01-01, UTC.
	day INTEGER NOT NULL,
	uploads INTEGER NOT NULL DEFAULT 0,
	edits INTEGER NOT NULL DEFAULT 0,
	images INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (user_id, day)
) WITHOUT ROWID;
CREATE INDEX upload_quota_day ON upload_quota (day);
