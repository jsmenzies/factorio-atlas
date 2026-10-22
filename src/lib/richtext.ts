/**
 * Factorio rich text in titles and labels: `[item=space-science-pack]`, `[fluid=water]`,
 * `[virtual-signal=signal-A]`, `[img=item/iron-plate]`, `[color=red]…[/color]` and so on.
 * Icons become segments; colour and font tags are dropped.
 */
import { iconKindOf, type IconKind } from './icons.js';

export type RichSegment =
	| { kind: 'text'; text: string }
	/** `icon` is the icon kind to look up; `null` for types without icons. */
	| { kind: 'icon'; type: string; name: string; icon: IconKind | null };

const TAG = /\[(\/?[a-z-]+)(?:=([^\]]*))?\]/g;

/** Types that name something worth an icon; anything else (`color`, `font`, `gps`) is dropped. */
const ICON_TYPES = new Set([
	'item',
	'fluid',
	'entity',
	'recipe',
	'virtual-signal',
	'technology',
	'planet',
	'space-location',
	'tile',
	'item-group',
	'quality',
	'img'
]);

const iconSegment = (type: string, value: string): RichSegment | null => {
	// `[item=foo,quality=rare]`: the name is before the comma.
	let name = value.split(',')[0].trim();
	if (!name) return null;
	if (type === 'img') {
		// `[img=item/iron-plate]`, `[img=virtual-signal/signal-A]`
		const slash = name.indexOf('/');
		if (slash < 0) return null;
		type = name.slice(0, slash);
		name = name.slice(slash + 1);
	}
	return { kind: 'icon', type, name, icon: iconKindOf(type) ?? null };
};

export const parseRichText = (s: string): RichSegment[] => {
	const out: RichSegment[] = [];
	const push = (text: string) => {
		if (!text) return;
		const last = out.at(-1);
		if (last?.kind === 'text') last.text += text;
		else out.push({ kind: 'text', text });
	};
	let at = 0;
	for (const m of s.matchAll(TAG)) {
		const [whole, type, value] = m;
		push(s.slice(at, m.index));
		at = m.index + whole.length;
		if (ICON_TYPES.has(type) && value !== undefined) {
			const icon = iconSegment(type, value);
			if (icon) out.push(icon);
		} else if (!/^\/?(color|font|gps|train|train-stop|special-item|armor|shortcut|tooltip)$/.test(type)) {
			push(whole); // Not rich text after all, e.g. "[WIP]".
		}
	}
	push(s.slice(at));
	return out;
};

const humanise = (name: string) => {
	const words = name.replace(/^signal-/, '').replaceAll('-', ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Text for places that can't hold icons (`<title>`, `<option>`): icons become their names. */
export const plainText = (s: string): string =>
	parseRichText(s)
		.map((seg) => (seg.kind === 'text' ? seg.text : ` ${humanise(seg.name)} `))
		.join('')
		.replace(/\s+/g, ' ')
		.trim();

/** The icons strings need, by kind, so loaders send only those. */
export const richTextIcons = (texts: (string | null | undefined)[]): Partial<Record<IconKind, string[]>> => {
	const out: Partial<Record<IconKind, string[]>> = {};
	for (const t of texts) {
		if (!t || !t.includes('[')) continue;
		for (const seg of parseRichText(t)) if (seg.kind === 'icon' && seg.icon) (out[seg.icon] ??= []).push(seg.name);
	}
	return out;
};
