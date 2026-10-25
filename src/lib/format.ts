/** "item:electronic-circuit" → "Electronic circuit" */
export const signalName = (signal: string) => {
	const name = signal.includes(':') ? signal.slice(signal.indexOf(':') + 1) : signal;
	const words = name.replaceAll('-', ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The unit rates are shown in: per second (the default) or per minute. Belt speeds are always per second. */
export type RateUnit = 's' | 'min';

const WHOLE: Record<RateUnit, Intl.NumberFormat> = {
	s: new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }),
	min: new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 })
};
const SMALL = new Intl.NumberFormat('en-GB', { maximumSignificantDigits: 2 });

/** A rate stored in items per second, in `unit`: "1.5/s", "90/min", "0.025/s", "36,710/min". Below 1, two significant figures. */
export const formatRate = (perSecond: number, unit: RateUnit = 's') => {
	const n = unit === 'min' ? perSecond * 60 : perSecond;
	return `${(n >= 1 ? WHOLE[unit] : SMALL).format(n)}/${unit}`;
};

/**
 * Imgur-hosted screenshot (the image factorioprints itself links to): "m" 320px, "l" 640px, "h"
 * 1024px (link previews), or the original. Imgur's resized copies are JPEG whatever the upload, so
 * the preview says so in its name.
 */
export const imgurUrl = (id: string, type: string | null, size: 'thumb' | 'large' | 'preview' | 'original' = 'thumb') => {
	const ext = size === 'preview' ? 'jpg' : (type?.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png');
	const suffix = { thumb: 'm', large: 'l', preview: 'h', original: '' }[size];
	return `https://i.imgur.com/${id}${suffix}.${ext}`;
};

export const sourceUrl = (id: string) => `https://factorioprints.com/view/${id}`;

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** "24 Oct 2026": the same on the server and in every browser, so hydration never disagrees. */
export const formatDate = (ms: number) => DAY.format(ms);
