import { describe, expect, test } from 'bun:test';
import { siteImage } from '../screenshots/site-images';
import { codexRecord, codexTags, type CodexBlueprint } from './codex';
import { linksIn } from './polled';

/** A made-up print in the API's shape (no player's work). */
const sample = (o: Partial<CodexBlueprint> = {}): CodexBlueprint => ({
	id: 42,
	title: ' Test smelter ',
	description: 'Import from factorio.school/view/x, see https://www.factorio.school/view/-AAAAAAAAAAAAAAAAAAAA for more.',
	user_id: 7,
	is_public: true,
	is_anonymous: false,
	created_at: '2026-10-01T10:00:00.5Z',
	updated_at: '2026-10-02T10:00:00Z',
	image_url: 'https://factoriocodex.s3.us-west-000.backblazeb2.com/1-a.png',
	game_version: '2.0.73.1',
	current_version: 2,
	author: { id: 7, username: 'Someone' },
	tags: [
		{ name: 'Smelting', category: 'Production' },
		{ name: 'Vulcanus Planet', category: 'Space Age Expansion' },
		{ name: 'Version 1.1', category: 'Version' },
		{ name: 'Beginner Friendly', category: 'Skill Level' }
	],
	versions: [
		{ version_number: 1, blueprint_string: '0eOLD' },
		{ version_number: 2, blueprint_string: '0eNEW\n' },
		{ version_number: 3, blueprint_string: '0eOLD' }
	],
	...o
});

describe('codexRecord', () => {
	test('a print as a SourceRecord: current string, older ones, author, times, mapped tags, links, its image', () => {
		const got = codexRecord(sample());
		expect('record' in got).toBe(true);
		if (!('record' in got)) return;
		expect(got.record).toEqual({
			site: 'codex',
			siteId: '42',
			url: 'https://factoriocodex.com/blueprints/42',
			title: 'Test smelter',
			description: sample().description,
			author: { site: 'codex', id: '7', name: 'Someone' },
			blueprintString: '0eNEW',
			versions: ['0eOLD'],
			image: { key: siteImage('codex', sample().image_url)!.key, url: 'https://factoriocodex.s3.us-west-000.backblazeb2.com/1-a.png' },
			uploadedAt: Date.UTC(2026, 9, 1, 10, 0, 0, 500),
			updatedAt: Date.UTC(2026, 9, 2, 10),
			favorites: null,
			tags: ['/version/2,0/', '/production/smelting/', '/planets/vulcanus/', '/version/1,1/'],
			sourceHints: ['https://www.factorio.school/view/-AAAAAAAAAAAAAAAAAAAA']
		});
	});

	test('anonymous: no author; not public: gone; no string: an error', () => {
		const anon = codexRecord(sample({ is_anonymous: true, user_id: null, author: null }));
		expect('record' in anon && anon.record.author).toBeNull();
		expect(codexRecord(sample({ is_public: false }))).toEqual({ gone: 'no longer public' });
		// An image anywhere but codex's bucket is not one we copy.
		const elsewhere = codexRecord(sample({ image_url: 'https://example.com/i.png' }));
		expect('record' in elsewhere && elsewhere.record.image).toBeNull();
		expect(() => codexRecord(sample({ versions: [] }))).toThrow('no blueprint string');
	});

	test('tags that mean nothing to factorioprints are dropped; links capped', () => {
		expect(codexTags([{ name: 'AFK Friendly' }, { name: 'Tileable' }], null)).toEqual(['/general/tileable/']);
		expect(linksIn(null)).toEqual([]);
		expect(linksIn('a http://x.y/1) b http://x.y/1')).toEqual(['http://x.y/1']);
	});
});
