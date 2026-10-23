-- Page thumbnails (`bun run render:thumbs`, #lib/viewer/thumbs.ts), kept beside the renders in the
-- RENDERS bucket as `<id>/<base>.<stamp>.t<tier>.avif` with a per-print `<id>/thumbs.json`.

-- A search card's thumbnail: the print's cover page (the first page in its thumbs.json, in book
-- order) and its overview's stamp and size, from which a card builds the file names and srcset
-- (thumbTiers). Written by `bun run render:flags` from the thumbnails uploaded to the stage's bucket;
-- NULL until the print's thumbnails are up.
ALTER TABLE print_renders ADD COLUMN cover_page TEXT;
ALTER TABLE print_renders ADD COLUMN cover_stamp TEXT;
ALTER TABLE print_renders ADD COLUMN cover_w INTEGER;
ALTER TABLE print_renders ADD COLUMN cover_h INTEGER;

-- What each target bucket holds, per print: the thumbs.json last uploaded there, whose files are all
-- up. `render:thumbs --upload` compares it with the one on disk, so an unchanged print costs no
-- request. Like render_uploads (0011), filled in the local database; deployed stages carry it empty.
-- Replaced and removed thumbnails wait in render_deletes (0012) before they go.
CREATE TABLE thumb_uploads (
	-- 'local' (the miniflare bucket) or 'prod'.
	target TEXT NOT NULL,
	print_id TEXT NOT NULL,
	-- The uploaded thumbs.json (ThumbsIndex), as uploaded.
	thumbs TEXT NOT NULL,
	-- Unix ms.
	uploaded_at INTEGER NOT NULL,
	PRIMARY KEY (target, print_id)
) WITHOUT ROWID;
