-- Site accounts (src/lib/server/auth/): people sign in with Discord, GitHub or Google, and the site keeps
-- only the provider's user id and a display name, never an email address, password or provider token.

CREATE TABLE users (
	-- Random (crypto.randomUUID()).
	id TEXT PRIMARY KEY,
	-- Shown on the account's uploads. Only ASCII letters, digits, spaces and `_.-` (nameProblem in
	-- src/lib/server/auth/users.ts), so NOCASE, which folds only ASCII, makes it unique ignoring case.
	-- Never a factorioprints author's name (`authors`), so nobody can pass as someone else.
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	-- Unix ms.
	created_at INTEGER NOT NULL,
	-- Set when an admin bans the account: its sessions stop working and it can't sign in again.
	banned_at INTEGER,
	ban_reason TEXT,
	-- Set when the owner deletes the account and its uploads are too many to delete in one request: the
	-- account page deletes the rest a chunk at a time, then the row (lib/server/uploads/uploads.ts,
	-- deleteAccountUploads). Meanwhile the account can't upload or edit.
	deleting_at INTEGER
) WITHOUT ROWID;

-- Which provider account signs in to which site account. One site account per provider account.
CREATE TABLE user_identities (
	-- 'discord' | 'github' | 'google' ('dev': vite dev's test sign-in)
	provider TEXT NOT NULL,
	-- The provider's own, permanent user id.
	subject TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	-- Unix ms.
	created_at INTEGER NOT NULL,
	PRIMARY KEY (provider, subject)
) WITHOUT ROWID;
CREATE INDEX user_identities_user ON user_identities (user_id);

-- Signed-in browsers. The cookie holds a random token; only its SHA-256 is stored, so a copy of the
-- database can't sign anyone in. At most SESSIONS_PER_USER per account (the oldest go); expired rows
-- are deleted by the daily cron (src/cron/views.ts, accountChores).
CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	-- Unix ms.
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions (user_id, created_at);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Names an account gave up (renamed away from, or deleted with the account). For NAME_HOLD_DAYS (30)
-- only that account may take one back, so nobody steps into a name people still know someone by.
-- No foreign key: the account may be gone. The daily cron deletes rows past the hold.
CREATE TABLE released_names (
	name TEXT PRIMARY KEY COLLATE NOCASE,
	user_id TEXT NOT NULL,
	-- Unix ms.
	released_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX released_names_at ON released_names (released_at);
