-- Copies of the prints' Imgur screenshots in the stage's SCREENSHOTS bucket (`bun run screenshots
-- --upload`; names and sizes in src/lib/screenshots.ts). Search cards join it by primary key on
-- prints.image_id: copied shows our copy; dead or removed shows no Imgur image; no row (not copied
-- yet) still shows Imgur's. Written only by `bun run screenshots:flags` (from what the uploads put
-- in the bucket, and screenshot_removals) and `bun run screenshots:remove`. The print and render
-- pages don't read it: they read each image's manifest in the bucket.
CREATE TABLE screenshots (
	-- Imgur id (case-sensitive).
	image_id TEXT PRIMARY KEY,
	-- 'copied': our copy is in the bucket; 'dead': gone from Imgur before it was copied; 'removed':
	-- deleted on Imgur since, or taken down on request.
	state TEXT NOT NULL,
	-- For 'copied' (NULL otherwise): SCREENSHOT_VERSION the sizes were made with (part of their
	-- file names), the original's extension (jpg | png | gif | webp) and its size in pixels (a GIF's
	-- first frame).
	v INTEGER,
	ext TEXT,
	w INTEGER,
	h INTEGER,
	-- Unix ms.
	updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Screenshots taken down on request (`bun run screenshots:remove`): their files are deleted from the
-- bucket, their manifest says 'removed', and their `screenshots` row is 'removed' (screenshots:flags
-- keeps it so, whatever the uploads say), so no page shows them, nor Imgur's copy.
CREATE TABLE screenshot_removals (
	image_id TEXT PRIMARY KEY,
	-- The print the request named, if it named one.
	print_id TEXT,
	reason TEXT,
	-- Unix ms.
	removed_at INTEGER NOT NULL
) WITHOUT ROWID;
