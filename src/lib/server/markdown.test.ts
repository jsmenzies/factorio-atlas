import { describe, expect, test } from 'bun:test';
import { renderDescription } from './markdown.js';

const REL = 'rel="nofollow ugc noopener noreferrer" target="_blank"';

/** No tag outside the allowlist, and no attribute that can run script. */
const expectSafe = (html: string) => {
	for (const m of html.matchAll(/<\/?([a-z0-9]+)/gi))
		expect(
			['p', 'br', 'hr', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'img'].includes(
				m[1]
			)
		).toBe(true);
	// Attribute names only: quoted values (escaped) may say anything.
	for (const tag of html.match(/<[^>]*>/g) ?? []) expect(/\son[a-z]+\s*=/i.test(tag.replace(/"[^"]*"/g, '""'))).toBe(false);
	for (const m of html.matchAll(/\s(href|src)="([^"]*)"/g)) expect(/^https?:\/\//.test(m[2])).toBe(true);
	expect(/\sstyle=/i.test(html)).toBe(false);
};

describe('renderDescription: Markdown', () => {
	test('empty and blank input render nothing', () => {
		expect(renderDescription(null)).toBe('');
		expect(renderDescription('  \n ')).toBe('');
	});

	test('paragraphs, emphasis, lists, quotes and code', () => {
		expect(renderDescription('Hello **bold** and *em*\n\nNext')).toBe('<p>Hello <strong>bold</strong> and <em>em</em></p>\n<p>Next</p>');
		expect(renderDescription('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
		expect(renderDescription('3. c\n4. d')).toBe('<ol start="3">\n<li>c</li>\n<li>d</li>\n</ol>');
		expect(renderDescription('> quoted `x < y`')).toBe('<blockquote>\n<p>quoted <code>x &lt; y</code></p>\n</blockquote>');
		expect(renderDescription('```\n<b>x</b>\n```')).toBe('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
	});

	test('headings are demoted below the page h1/h2', () => {
		expect(renderDescription('# One')).toBe('<h3>One</h3>');
		expect(renderDescription('## Two')).toBe('<h4>Two</h4>');
		expect(renderDescription('#### Four')).toBe('<h6>Four</h6>');
		expect(renderDescription('###### Six')).toBe('<h6>Six</h6>');
	});

	test('links get rel and target; bare URLs are linked', () => {
		expect(renderDescription('[Nilaus](https://www.youtube.com/watch?v=1&list=2)')).toBe(
			`<p><a href="https://www.youtube.com/watch?v=1&amp;list=2" ${REL}>Nilaus</a></p>`
		);
		expect(renderDescription('see https://pastebin.com/vYAgMF6k')).toBe(
			`<p>see <a href="https://pastebin.com/vYAgMF6k" ${REL}>https://pastebin.com/vYAgMF6k</a></p>`
		);
	});

	test('images are https only, lazy, with no referrer', () => {
		expect(renderDescription('![shot](https://i.imgur.com/abc.png)')).toBe(
			'<p><img src="https://i.imgur.com/abc.png" alt="shot" loading="lazy" referrerpolicy="no-referrer"></p>'
		);
		expect(renderDescription('![shot](http://i.imgur.com/abc.png)')).toBe('<p>shot</p>');
	});

	test('<br> becomes a line break, other HTML is dropped but its text kept', () => {
		expect(renderDescription('one<br>two<br/>three<BR />four')).toBe('<p>one<br>two<br>three<br>four</p>');
		expect(renderDescription('<b>bold</b> and <a href="https://x.com">link</a>')).toBe('<p>bold and link</p>');
	});

	test('a <details> changelog keeps its lines and links', () => {
		const html = renderDescription(
			'<details><summary><b>Changelog</b></summary>\n2017-07-08: Fix https://imgur.com/LnSE2Mo<br/>\n2017-07-10: More<br/>\n</details>'
		);
		expect(html).toBe(
			`<p>Changelog<br>\n2017-07-08: Fix <a href="https://imgur.com/LnSE2Mo" ${REL}>https://imgur.com/LnSE2Mo</a><br>\n2017-07-10: More</p>`
		);
	});

	test('things that only look like tags are shown as text', () => {
		expect(renderDescription('Use <Blue Belt> here, a < b > c')).toBe('<p>Use &lt;Blue Belt&gt; here, a &lt; b &gt; c</p>');
	});

	test('tables become rows of text', () => {
		expect(renderDescription('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('<p>a | b<br>1 | 2</p>');
	});
});

describe('renderDescription: Factorio rich text', () => {
	test('rich-text tags become words', () => {
		expect(renderDescription('Makes [item=iron-plate] from [fluid=water]')).toBe('<p>Makes Iron plate from Water</p>');
		expect(renderDescription('**[item=space-science-pack] x** [color=red]red[/color]')).toBe(
			'<p><strong>Space science pack x</strong> red</p>'
		);
		expect(renderDescription('# [virtual-signal=signal-A] Mall')).toBe('<h3>A Mall</h3>');
	});

	test('rich text inside code is left alone', () => {
		expect(renderDescription('`[item=iron-plate]`')).toBe('<p><code>[item=iron-plate]</code></p>');
	});

	test('rich text in link text, and brackets that are not rich text', () => {
		expect(renderDescription('[[item=iron-plate] plates](https://x.com)')).toBe(
			`<p><a href="https://x.com/" ${REL}>Iron plate plates</a></p>`
		);
		expect(renderDescription('[WIP] book')).toBe('<p>[WIP] book</p>');
	});
});

describe('renderDescription: XSS', () => {
	const cases: [string, string][] = [
		['<script>alert(1)</script>', ''],
		['before <script>alert(1)</script> after', '<p>before alert(1) after</p>'],
		['<img src=x onerror=alert(1)>', ''],
		['hi <img src="x" onerror="alert(1)"> there', '<p>hi  there</p>'],
		['<svg onload=alert(1)>', ''],
		['<a href="javascript:alert(1)" onclick="alert(1)">click</a>', '<p>click</p>'],
		['[click](javascript:alert(1))', '<p>click</p>'],
		['[click](JaVaScRiPt:alert(1))', '<p>click</p>'],
		['[click](<javascript:alert(1)>)', '<p>click</p>'],
		['[click](java\tscript:alert(1))', '<p>[click](java script:alert(1))</p>'],
		['[click](&#106;avascript:alert(1))', '<p>click</p>'],
		['<javascript:alert(1)>', '<p>javascript:alert(1)</p>'],
		['[click](data:text/html,<script>alert(1)</script>)', '<p>click</p>'],
		['![x](data:image/png;base64,iVBORw0KGgo=)', '<p>x</p>'],
		['![x](javascript:alert(1))', '<p>x</p>'],
		[
			'![x" onerror="alert(1)](https://i.imgur.com/a.png)',
			'<p><img src="https://i.imgur.com/a.png" alt="x&quot; onerror=&quot;alert(1)" loading="lazy" referrerpolicy="no-referrer"></p>'
		],
		[
			'[x](https://ok.com "a\\" onmouseover=\\"alert(1)")',
			`<p><a href="https://ok.com/" title="a&quot; onmouseover=&quot;alert(1)" ${REL}>x</a></p>`
		],
		['<p style="color:red">styled</p>', '<p>styled</p>'],
		['<iframe src="https://evil.com"></iframe>', ''],
		['**<img src=x onerror=alert(1)>bold**', '<p><strong>bold</strong></p>'],
		['- <a href="javascript:x">item</a>', '<ul>\n<li>item</li>\n</ul>'],
		['&lt;script&gt;alert(1)&lt;/script&gt;', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
		['&#60;script&#62;alert(1)&#60;/script&#62;', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
		['<pre><img src=x onerror=alert(1)></pre>', ''],
		['<!-- <script>alert(1)</script> -->', ''],
		['[item=<img src=x onerror=alert(1)>]', '<p>[item=]</p>']
	];
	for (const [input, expected] of cases)
		test(JSON.stringify(input), () => {
			const html = renderDescription(input);
			expect(html).toBe(expected);
			expectSafe(html);
		});
});
