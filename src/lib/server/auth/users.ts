/**
 * Site accounts (migration 0023): one per provider account, made at its first sign-in. Names use
 * only ASCII letters, digits, spaces and `_.-` (NAME_RULE), so SQLite's NOCASE (which folds only
 * ASCII) makes uniqueness exact and no look-alike letter can pass as someone else. A name can't be a
 * factorioprints author's (compared after stripping the author's name to the same characters), and a
 * name an account gives up (rename or deletion) is held for NAME_HOLD_DAYS before another can take it.
 * The owner changes it at routes/account.
 */
import type { Profile, Provider } from './providers.js';

export interface Account {
	id: string;
	name: string;
	/** Its owner deleted it and its uploads are still going (users.deleting_at): it can't upload or edit. */
	deleting?: boolean;
}

export const NAME_MIN = 2;
export const NAME_MAX = 32;
export const NAME_HOLD_DAYS = 30;
const DAY_MS = 86_400_000;

/** What a name may hold, as the account page explains it. */
export const NAME_RULE = `${NAME_MIN}–${NAME_MAX} characters: letters A–Z, digits, spaces, dots, dashes and underscores, starting with a letter or digit.`;
const ALLOWED = /^[A-Za-z0-9 _.-]*$/;

/** Names nobody may take, ignoring case. */
const RESERVED = new Set([
	'admin',
	'administrator',
	'moderator',
	'mod',
	'staff',
	'blueprint atlas',
	'factorio',
	'factorioprints',
	'wube',
	'anonymous',
	'deleted',
	'deleted account',
	'unknown'
]);

/** The first `n` characters, by code point (never half a surrogate pair). */
const head = (s: string, n: number) => [...s].slice(0, n).join('');

/** Trims and turns every run of whitespace into one space; nothing else changes. */
const tidy = (raw: string) => raw.replace(/\s+/g, ' ').trim();

/** Drops everything before the first letter or digit and after the last. */
const trimEnds = (s: string) => s.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

/** Someone else's text (a handle, an author's name) reduced to the allowed characters, spaces tidied. */
const strip = (raw: string) => tidy(raw.replace(/[^A-Za-z0-9\s_.-]/g, ''));

/**
 * A name made from a provider's handle: NFKC first (full-width letters become ASCII), every
 * character outside the allowed set dropped, cut to NAME_MAX, punctuation at either end dropped.
 */
export const cleanName = (raw: string) => trimEnds(head(strip(raw.normalize('NFKC')), NAME_MAX));

/**
 * Why a name typed by its owner can't be used, ignoring whether it's taken; null when it can. The
 * name is tidied first (trimmed, single spaces), never otherwise changed: a character outside the
 * set is refused, not dropped, so nobody gets a name they didn't type.
 */
export const nameProblem = (raw: string) => {
	const name = tidy(raw);
	if (!ALLOWED.test(name)) return `That name has a character that isn’t allowed. Names are ${NAME_RULE}`;
	if (name.length < NAME_MIN || name.length > NAME_MAX) return `Names are ${NAME_MIN}–${NAME_MAX} characters long.`;
	if (!/^[A-Za-z0-9]/.test(name)) return 'Names start with a letter or digit.';
	if (RESERVED.has(name.toLowerCase())) return 'That name is reserved.';
	return null;
};

/** LIKE pattern matching any text that holds `name`'s characters in order (the authors pre-filter). */
const subsequencePattern = (name: string) => `%${[...name].map((c) => (c === '%' || c === '_' || c === '\\' ? `\\${c}` : c)).join('%')}%`;

/**
 * Whether a factorioprints author's name, stripped to the allowed characters, is `name` (ignoring
 * case): "Nilaus!" reserves "Nilaus". SQLite can't strip characters, so LIKE (case-insensitive for
 * ASCII) finds the authors whose name holds the characters in order, and the exact check runs here.
 * It scans `authors` (about 8,000 rows), once per sign-up or rename.
 */
const authorHas = async (db: D1Database, name: string) => {
	const key = name.toLowerCase();
	const { results } = await db
		.prepare(`SELECT display_name FROM authors WHERE display_name LIKE ? ESCAPE '\\'`)
		.bind(subsequencePattern(name))
		.all<{ display_name: string }>();
	return results.some((r) => strip(r.display_name).toLowerCase() === key);
};

/**
 * Whether `name` is unavailable to the account `exceptUserId`: another account's (NOCASE), a
 * factorioprints author's, held for NAME_HOLD_DAYS after another account gave it up, or still shown on
 * another account's uploads (a rename not yet on all of them: uploads.ts refreshUploadNames).
 */
export const nameTaken = async (db: D1Database, name: string, exceptUserId = '', now = Date.now()) => {
	const row = await db
		.prepare(
			`SELECT EXISTS (SELECT 1 FROM users WHERE name = ?1 AND id <> ?2)
			OR EXISTS (SELECT 1 FROM released_names WHERE name = ?1 AND user_id <> ?2 AND released_at > ?3)
			OR EXISTS (SELECT 1 FROM uploads WHERE shown_name = ?1 COLLATE NOCASE AND user_id <> ?2) AS taken`
		)
		.bind(name, exceptUserId, now - NAME_HOLD_DAYS * DAY_MS)
		.first<{ taken: number }>();
	return row?.taken === 1 || (await authorHas(db, name));
};

/** `n` random digits, the first not 0. */
const randomDigits = (n: number) =>
	[...crypto.getRandomValues(new Uint8Array(n))].map((b, i) => String(i === 0 ? 1 + (b % 9) : b % 10)).join('');

/**
 * A free name for a new account. A Discord or GitHub handle is kept (cleaned): as it is, else with
 * " 2" … " 5". With no usable handle (and always for Google, whose names are often people's real
 * ones), "Engineer" and four random digits; six after a few collisions.
 */
export const freeName = async (db: D1Database, raw: string, now = Date.now()) => {
	const cleaned = cleanName(raw);
	if (nameProblem(cleaned) === null) {
		const withSuffix = (n: number) => `${trimEnds(head(cleaned, NAME_MAX - 2))} ${n}`;
		for (const candidate of [cleaned, ...[2, 3, 4, 5].map(withSuffix)]) {
			if (!(await nameTaken(db, candidate, '', now))) return candidate;
		}
	}
	for (let attempt = 0; ; attempt++) {
		const candidate = `Engineer ${randomDigits(attempt < 5 ? 4 : 6)}`;
		if (attempt >= 10 || !(await nameTaken(db, candidate, '', now))) return candidate;
	}
};

/** D1 and bun:sqlite both name the constraint in the message. */
const isUniqueError = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

/** The `users` columns an Account is made from. */
export interface AccountRow {
	id: string;
	name: string;
	banned_at: number | null;
	deleting_at: number | null;
}

export const accountOf = (row: AccountRow): Account => ({
	id: row.id,
	name: row.name,
	...(row.deleting_at === null ? {} : { deleting: true })
});

export type SignInResult = { ok: true; account: Account; created: boolean } | { ok: false; reason: 'banned' };

/** The account a provider account signs in to, made on its first sign-in. `provider` is 'dev' only for vite dev's test sign-in. */
export const signInAccount = async (
	db: D1Database,
	provider: Provider | 'dev',
	profile: Profile,
	now = Date.now()
): Promise<SignInResult> => {
	const find = () =>
		db
			.prepare(
				`SELECT u.id, u.name, u.banned_at, u.deleting_at FROM user_identities i JOIN users u ON u.id = i.user_id
				WHERE i.provider = ? AND i.subject = ?`
			)
			.bind(provider, profile.subject)
			.first<AccountRow>();
	const answer = (row: AccountRow, created: boolean): SignInResult =>
		row.banned_at === null ? { ok: true, account: accountOf(row), created } : { ok: false, reason: 'banned' };
	const known = await find();
	if (known) return answer(known, false);

	const id = crypto.randomUUID();
	let name = await freeName(db, profile.name, now);
	for (let attempt = 0; ; attempt++) {
		try {
			// One batch is one transaction: the account and its identity, or neither.
			await db.batch([
				db.prepare(`INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)`).bind(id, name, now),
				db
					.prepare(`INSERT INTO user_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)`)
					.bind(provider, profile.subject, id, now)
			]);
			return { ok: true, account: { id, name }, created: true };
		} catch (e) {
			// The same provider account signing in twice at once: the other request made it.
			const raced = await find();
			if (raced) return answer(raced, false);
			// Someone took the name in between.
			if (!isUniqueError(e) || attempt >= 2) throw e;
			name = `Engineer ${randomDigits(6)}`;
		}
	}
};

export type RenameResult = { ok: true; name: string } | { ok: false; problem: string };

/** Holds `name`, given up by `userId`: only that account may take it back within NAME_HOLD_DAYS. */
const releaseName = (db: D1Database, name: string, userId: string, now: number) =>
	db
		.prepare(
			`INSERT INTO released_names (name, user_id, released_at) VALUES (?, ?, ?)
			ON CONFLICT (name) DO UPDATE SET user_id = excluded.user_id, released_at = excluded.released_at`
		)
		.bind(name, userId, now);

/** Changes an account's name; refuses one that's malformed, reserved or taken. The old name is held (releaseName). */
export const renameAccount = async (db: D1Database, userId: string, raw: string, now = Date.now()): Promise<RenameResult> => {
	const problem = nameProblem(raw);
	if (problem) return { ok: false, problem };
	const name = tidy(raw);
	const current = await db.prepare(`SELECT name FROM users WHERE id = ?`).bind(userId).first<{ name: string }>();
	if (!current) return { ok: false, problem: 'No such account.' };
	if (current.name === name) return { ok: true, name };
	if (await nameTaken(db, name, userId, now)) return { ok: false, problem: 'That name is taken.' };
	const sameIgnoringCase = current.name.toLowerCase() === name.toLowerCase();
	try {
		await db.batch([
			db.prepare(`UPDATE users SET name = ? WHERE id = ?`).bind(name, userId),
			// Taking back one's own held name ends its hold.
			db.prepare(`DELETE FROM released_names WHERE name = ? AND user_id = ?`).bind(name, userId),
			...(sameIgnoringCase ? [] : [releaseName(db, current.name, userId, now)])
		]);
	} catch (e) {
		if (isUniqueError(e)) return { ok: false, problem: 'That name is taken.' };
		throw e;
	}
	return { ok: true, name };
};

/** The providers an account signs in with. */
export const accountProviders = async (db: D1Database, userId: string) =>
	(
		await db
			.prepare(`SELECT provider FROM user_identities WHERE user_id = ? ORDER BY created_at`)
			.bind(userId)
			.all<{ provider: Provider | 'dev' }>()
	).results.map((r) => r.provider);

/**
 * The owner asked to delete the account: from now on it can't upload, edit or rename, and the account page
 * deletes its uploads (lib/server/uploads/uploads.ts deleteAccountUploads) before `deleteAccount`.
 */
export const markDeleting = (db: D1Database, userId: string, now = Date.now()) =>
	db.prepare(`UPDATE users SET deleting_at = coalesce(deleting_at, ?) WHERE id = ?`).bind(now, userId).run();

/**
 * Deletes an account, its sign-ins, sessions and upload counts, forgets it on the screenshots it sent, and
 * holds its name; false (nothing changed) while it has uploads left: `uploads` refers to the account, so
 * they go first (lib/server/uploads/uploads.ts deleteAccountUploads).
 */
export const deleteAccount = async (db: D1Database, userId: string, now = Date.now()) => {
	const current = await db
		.prepare(`SELECT name, EXISTS (SELECT 1 FROM uploads WHERE user_id = ?1) AS uploads FROM users WHERE id = ?1`)
		.bind(userId)
		.first<{ name: string; uploads: number }>();
	if (current?.uploads) return false;
	await db.batch([
		...(current ? [releaseName(db, current.name, userId, now)] : []),
		db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
		// Its daily upload counts, and its name on images other uploads still use (migration 0024).
		db.prepare(`DELETE FROM upload_quota WHERE user_id = ?`).bind(userId),
		db.prepare(`UPDATE upload_images SET user_id = NULL WHERE user_id = ?`).bind(userId),
		db.prepare(`DELETE FROM user_identities WHERE user_id = ?`).bind(userId),
		db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId)
	]);
	return true;
};
