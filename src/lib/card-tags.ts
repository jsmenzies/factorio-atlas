/**
 * What a search result card shows about a print beyond its title: one game version chip and the "New"
 * badge. Decided once on the server (routes/+page.server.ts), so the cached HTML and the browser agree.
 */

/** "2.1.21" → [2, 1]; "0.16" → [0, 16]; anything without two numbers → null. */
const majorMinor = (version: string): [number, number] | null => {
	const parts = version.split('.');
	if (parts.length < 2 || !parts.slice(0, 2).every((p) => /^\d+$/.test(p))) return null;
	return [Number(parts[0]), Number(parts[1])];
};

const newer = (a: [number, number], b: [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

export interface CardVersion {
	/** Major.minor, e.g. "2.1": the chip's label and its `?version=` filter value. */
	label: string;
	/** The exact version the string was saved in, e.g. "2.1.21", for the tooltip; null without one. */
	saved: string | null;
	/** At or past the newest major.minor the game data knows (`latest`): the chip is highlighted. */
	latest: boolean;
}

/**
 * The newest major.minor among the version a print was saved in and the versions it claims, or null
 * when neither has one. `latest` is the game data's version (e.g. "2.1.23"), only its major.minor counts.
 */
export const cardVersion = (gameVersion: string | null, claimed: string[], latest: string): CardVersion | null => {
	let best: [number, number] | null = null;
	for (const v of [gameVersion, ...claimed]) {
		const mm = v ? majorMinor(v) : null;
		if (mm && (!best || newer(mm, best))) best = mm;
	}
	if (!best) return null;
	const top = majorMinor(latest);
	return { label: `${best[0]}.${best[1]}`, saved: gameVersion, latest: !!top && !newer(top, best) };
};

/** How long a print counts as new after it was first posted. */
export const NEW_FOR_MS = 2 * 24 * 60 * 60 * 1000;

/** Whether a print first posted at `createdAt` (epoch ms, the source's own date) is still new at `now`. */
export const isNewPrint = (createdAt: number | null, now: number) => createdAt !== null && now - createdAt < NEW_FOR_MS;

/** Factorio's major.minor releases with blueprint strings, newest first (versionChoices adds a newer one from the game data). */
const RELEASES = ['2.1', '2.0', '1.1', '1.0', '0.18', '0.17', '0.16', '0.15'];

/**
 * The search's "Game version" choices, newest first: the game data's major.minor (`latest`, e.g. "2.1.23"),
 * then every older release. Each is a `?version=` value: prints saved in it or claiming it.
 */
export const versionChoices = (latest: string): string[] => {
	const top = majorMinor(latest);
	if (!top) return RELEASES;
	const label = `${top[0]}.${top[1]}`;
	const older = RELEASES.filter((v) => !newer(majorMinor(v)!, top));
	return older.includes(label) ? older : [label, ...older];
};
