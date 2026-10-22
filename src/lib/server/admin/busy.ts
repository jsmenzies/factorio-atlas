/**
 * Locally, `bun run render` and `bun run backfill` write to the same SQLite file the dev server
 * reads (two workerd processes, one file). Every D1 call there, reads included, is a storage
 * transaction that asks for a commit token, and one that meets the other process's write lock
 * fails with SQLITE_BUSY ("database is locked", surfacing as "Failed to get session commit token").
 * While a render keeps every CPU thread busy, the dev server's own call to its workerd can also
 * drop ("fetch failed", from miniflare's undici). The admin pages retry those, and only those, and
 * read in as few calls as they can (one `db.batch` per load), since each call can meet the lock.
 */

const BUSY = /SQLITE_BUSY|database is locked|session commit token|^TypeError: fetch failed$|^fetch failed$/i;

export const isBusy = (e: unknown) =>
	BUSY.test(e instanceof Error ? `${e.name === 'TypeError' ? 'TypeError: ' : ''}${e.message}` : String(e));

/** Waits before try 2, 3, …: about 3 s in all over 6 tries, jittered so two callers don't retry in step. */
const backoff = (attempt: number) => 50 * 2 ** attempt * (0.75 + Math.random() / 2);

/** Run `f` again while the database is busy: 6 tries over about 3 s, then the error is thrown. */
export async function retryBusy<T>(f: () => Promise<T>, attempts = 6): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await f();
		} catch (e) {
			if (attempt >= attempts || !isBusy(e)) throw e;
			await new Promise((resolve) => setTimeout(resolve, backoff(attempt)));
		}
	}
}

/** What `orBusy` returns when the database stayed busy. */
export const BUSY_RESULT = Symbol('busy');

/** The value of `f` through retryBusy, or BUSY_RESULT when the database stayed busy; any other error is thrown. */
export async function orBusy<T>(f: () => Promise<T>, attempts?: number): Promise<T | typeof BUSY_RESULT> {
	try {
		return await retryBusy(f, attempts);
	} catch (e) {
		if (isBusy(e)) {
			console.warn(`admin: the local database stayed busy: ${e instanceof Error ? e.message : e}`);
			return BUSY_RESULT;
		}
		throw e;
	}
}
