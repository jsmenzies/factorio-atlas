/**
 * Print descriptions: untrusted Markdown from factorioprints.com users → safe HTML.
 *
 * Two layers, both DOM-free so they run in Workers:
 * 1. `marked` with a renderer that only ever emits allowlisted tags. Raw HTML never passes:
 *    `<br>` becomes a line break, other HTML tags are dropped (their text stays), and
 *    anything else that looks like a tag is escaped. Links must be http(s), images https.
 * 2. `xss` with a strict allowlist as a backstop, in case a renderer bug lets markup through.
 *
 * Factorio rich text (`[item=iron-plate]`) in text becomes words via `plainText`.
 */
import { Marked, type Tokens } from 'marked';
import xss from 'xss';
import type * as XSS from 'xss';
import { plainText } from '#lib/richtext.js';

// xss is CommonJS and adds most exports in a loop, so Node can't see them as named ESM exports
// (and its typings call the default export a plain function). The default export is the module.
const { FilterXSS, escapeAttrValue, friendlyAttrValue } = xss as unknown as typeof XSS;

const LINK_REL = 'nofollow ugc noopener noreferrer';

/** `<`, `>`, quotes and bare `&` (entities such as `&lt;` stay, as Markdown intends). */
const escapeHtml = (s: string) =>
	s
		.replace(/&(?!#?\w+;)/g, '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

/** Every character escaped, for attribute values such as URLs. */
const escapeAttr = (s: string) =>
	s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** The URL if it parses and uses one of `protocols`, else null. */
const safeUrl = (href: string, protocols: string[]): string | null => {
	try {
		const url = new URL(href.trim());
		return protocols.includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
};

/** Rich-text tags as words, keeping the whitespace around the text so it still joins its neighbours. */
const richToText = (s: string) => {
	if (!s.includes('[')) return s;
	const lead = /^\s*/.exec(s)?.[0] ?? '';
	const trail = /\s*$/.exec(s)?.[0] ?? '';
	const words = plainText(s);
	return words ? lead + words + trail : lead || trail;
};

/** HTML element names whose tags are dropped (text kept). Other `<…>` is escaped, e.g. "<Blue Belt>". */
const HTML_TAGS = new Set(
	(
		'a abbr address article aside audio b bdi bdo big blockquote body br button caption center cite code col colgroup dd del details ' +
		'dfn div dl dt em embed fieldset figcaption figure font footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input ins ' +
		'kbd label legend li link main mark marquee math meta nav noscript object ol optgroup option p param picture pre q s samp script ' +
		'section select small source span strike strong style sub summary sup svg table tbody td template textarea tfoot th thead title tr ' +
		'tt u ul var video wbr'
	).split(' ')
);

/** One raw HTML tag (or comment) from the source. */
const rawTag = (tag: string): string => {
	if (/^<br\s*\/?>$/i.test(tag) || /^<\/br\s*>$/i.test(tag)) return '<br>';
	// The end of a block, e.g. a `<details>` changelog's `</summary>`, still ends the line.
	if (/^<\/(summary|p|div|h[1-6])\s*>$/i.test(tag)) return '<br>';
	if (/^<(!|\?)/.test(tag)) return ''; // comments, doctypes, CDATA, processing instructions
	const name = /^<\/?([a-z][a-z0-9-]*)/i.exec(tag)?.[1]?.toLowerCase();
	return name && HTML_TAGS.has(name) ? '' : escapeHtml(tag);
};

/** Line breaks at the end of a paragraph only add space. */
const trimBreaks = (html: string) => html.replace(/(\s*<br>)+\s*$/, '').trim();

const md = new Marked({
	gfm: true,
	breaks: false,
	async: false,
	renderer: {
		// Block HTML (e.g. a `<details>` changelog): render its contents as inline Markdown, so tags
		// go through `html` below one by one and bare URLs still become links.
		html(token: Tokens.HTML | Tokens.Tag) {
			if (!('block' in token) || !token.block) return rawTag(token.text);
			const body = token.text.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').trim();
			const inner = trimBreaks(md.parseInline(body, { async: false }));
			return inner ? `<p>${inner}</p>\n` : '';
		},
		paragraph({ tokens }) {
			const inner = trimBreaks(this.parser.parseInline(tokens));
			return inner ? `<p>${inner}</p>\n` : '';
		},
		// Text is always escaped here: marked leaves text after a raw `<script>`/`<pre>` tag unescaped.
		text(token: Tokens.Text | Tokens.Escape) {
			if (token.type === 'text' && token.tokens) return this.parser.parseInline(token.tokens);
			return escapeHtml(token.type === 'text' ? richToText(token.text) : token.text);
		},
		// The page's h1/h2 stay on top: `#` becomes h3, and so on down to h6.
		heading({ tokens, depth }) {
			const level = Math.min(depth + 2, 6);
			return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
		},
		code({ text }) {
			return `<pre><code>${escapeHtml(text.replace(/\n$/, ''))}</code></pre>\n`;
		},
		codespan({ text }) {
			return `<code>${escapeHtml(text)}</code>`;
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeUrl(href, ['http:', 'https:']);
			if (!url) return inner;
			const t = title ? ` title="${escapeAttr(title)}"` : '';
			return `<a href="${escapeAttr(url)}"${t} rel="${LINK_REL}" target="_blank">${inner}</a>`;
		},
		image({ href, title, text }) {
			const url = safeUrl(href, ['https:']);
			const alt = richToText(text);
			if (!url) return escapeHtml(alt);
			const t = title ? ` title="${escapeAttr(title)}"` : '';
			return `<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}"${t} loading="lazy" referrerpolicy="no-referrer">`;
		},
		checkbox({ checked }) {
			return checked ? '☑ ' : '☐ ';
		},
		// Tables aren't allowed: each row becomes a line of `|`-separated cells.
		table(token) {
			const row = (cells: Tokens.TableCell[]) => cells.map((c) => this.parser.parseInline(c.tokens)).join(' | ');
			return `<p>${[row(token.header), ...token.rows.map(row)].join('<br>')}</p>\n`;
		}
	}
});

/** Only what the renderer above emits; everything else is stripped. */
const ALLOW: Record<string, string[]> = {
	a: ['href', 'title', 'rel', 'target'],
	img: ['src', 'alt', 'title', 'loading', 'referrerpolicy'],
	...Object.fromEntries(
		['p', 'br', 'hr', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'li'].map((t) => [t, []])
	),
	ol: ['start']
};

/** An allowlisted attribute's safe value, or '' to drop the attribute. */
const attrValue = (tag: string, name: string, raw: string): string => {
	const v = friendlyAttrValue(raw).trim();
	if (name === 'href') return tag === 'a' && /^https?:\/\//i.test(v) ? escapeAttrValue(v) : '';
	if (name === 'src') return tag === 'img' && /^https:\/\//i.test(v) ? escapeAttrValue(v) : '';
	if (name === 'rel') return LINK_REL;
	if (name === 'target') return '_blank';
	if (name === 'loading') return 'lazy';
	if (name === 'referrerpolicy') return 'no-referrer';
	if (name === 'start') return /^\d{1,9}$/.test(v) ? v : '';
	return escapeAttrValue(v); // alt, title
};

const filter = new FilterXSS({
	whiteList: ALLOW,
	stripIgnoreTag: true,
	stripIgnoreTagBody: ['script', 'style'],
	allowCommentTag: false,
	css: false,
	// Returning '' drops the attribute; undefined (not allowlisted) falls through to xss, which drops it too.
	onTagAttr(tag, name, value, isWhiteAttr) {
		if (!isWhiteAttr) return undefined;
		const v = attrValue(tag, name, value);
		return v ? `${name}="${v}"` : '';
	}
});

/** Sanitised HTML for a print description; '' when there's nothing to show. */
export const renderDescription = (source: string | null | undefined): string => {
	const text = String(source ?? '');
	if (!text.trim()) return '';
	return filter.process(md.parse(text, { async: false })).trim();
};
