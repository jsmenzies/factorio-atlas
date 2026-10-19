/** "item:electronic-circuit" → "Electronic circuit" */
export const signalName = (signal: string) => {
	const name = signal.includes(':') ? signal.slice(signal.indexOf(':') + 1) : signal;
	const words = name.replaceAll('-', ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
};

export const formatRate = (perSecond: number) => (perSecond >= 1 ? `${+perSecond.toFixed(2)}/s` : `${+(perSecond * 60).toFixed(1)}/min`);

/** Imgur-hosted screenshot (the image factorioprints itself links to): "m" 320px, "l" 640px, or the original. */
export const imgurUrl = (id: string, type: string | null, size: 'thumb' | 'large' | 'original' = 'thumb') => {
	const ext = type?.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
	const suffix = { thumb: 'm', large: 'l', original: '' }[size];
	return `https://i.imgur.com/${id}${suffix}.${ext}`;
};

export const sourceUrl = (id: string) => `https://factorioprints.com/view/${id}`;
