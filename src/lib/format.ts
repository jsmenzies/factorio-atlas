/** "item:electronic-circuit" → "Electronic circuit" */
export const signalName = (signal: string) => {
	const name = signal.includes(':') ? signal.slice(signal.indexOf(':') + 1) : signal;
	const words = name.replaceAll('-', ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
};

export const formatRate = (perSecond: number) => (perSecond >= 1 ? `${+perSecond.toFixed(2)}/s` : `${+(perSecond * 60).toFixed(1)}/min`);

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
