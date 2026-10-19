import { describe, expect, test } from 'bun:test';
import { accessConfig, teamKeys, verifyAccessJwt, verifyAccessRequest, type AccessConfig, type KeyLookup } from './access.js';

const config: AccessConfig = { issuer: 'https://team.cloudflareaccess.com', aud: 'aud-tag-123' };
const KID = 'key-1';

const b64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

const newPair = () =>
	crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify']
	);

const keyPair = await newPair();
const otherPair = await newPair();
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

const sign = async (payload: Record<string, unknown>, header: Record<string, unknown> = {}, key = keyPair.privateKey) => {
	const input = `${enc({ alg: 'RS256', kid: KID, typ: 'JWT', ...header })}.${enc(payload)}`;
	const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
	return `${input}.${b64url(new Uint8Array(sig))}`;
};

const now = Date.UTC(2026, 9, 19, 12);
const claims = (over: Record<string, unknown> = {}) => ({
	iss: config.issuer,
	aud: [config.aud],
	sub: 'user-1',
	email: 'someone@example.com',
	iat: now / 1000 - 60,
	nbf: now / 1000 - 60,
	exp: now / 1000 + 3600,
	...over
});
const keys: KeyLookup = async (kid) => (kid === KID ? keyPair.publicKey : null);

describe('verifyAccessJwt', () => {
	test('accepts a valid token and returns the identity', async () => {
		const result = await verifyAccessJwt(await sign(claims()), config, keys, now);
		expect(result).toEqual({ ok: true, identity: { sub: 'user-1', email: 'someone@example.com' } });
	});

	test('accepts aud as a plain string', async () => {
		expect((await verifyAccessJwt(await sign(claims({ aud: config.aud })), config, keys, now)).ok).toBe(true);
	});

	const rejects: [string, Record<string, unknown>, string][] = [
		['wrong aud', claims({ aud: ['another-app'] }), 'wrong aud'],
		['wrong issuer', claims({ iss: 'https://evil.cloudflareaccess.com' }), 'wrong iss'],
		['expired', claims({ exp: now / 1000 - 120 }), 'expired'],
		['missing exp', claims({ exp: undefined }), 'expired'],
		['not yet valid', claims({ nbf: now / 1000 + 600 }), 'not yet valid'],
		['no sub', claims({ sub: undefined }), 'no sub']
	];
	for (const [name, payload, reason] of rejects) {
		test(`rejects ${name}`, async () => {
			const result = await verifyAccessJwt(await sign(payload), config, keys, now);
			expect(result.ok ? null : result.reason.split(' ').slice(0, reason.split(' ').length).join(' ')).toBe(reason);
		});
	}

	test('allows small clock skew on exp', async () => {
		expect((await verifyAccessJwt(await sign(claims({ exp: now / 1000 - 10 })), config, keys, now)).ok).toBe(true);
	});

	test('rejects a token signed by another key', async () => {
		const token = await sign(claims(), {}, otherPair.privateKey);
		expect(await verifyAccessJwt(token, config, keys, now)).toEqual({ ok: false, reason: 'bad signature' });
	});

	test('rejects a tampered payload', async () => {
		const [h, , s] = (await sign(claims())).split('.');
		const forged = `${h}.${enc(claims({ email: 'attacker@example.com' }))}.${s}`;
		expect(await verifyAccessJwt(forged, config, keys, now)).toEqual({ ok: false, reason: 'bad signature' });
	});

	test('rejects alg none and HS256', async () => {
		const none = `${enc({ alg: 'none', kid: KID })}.${enc(claims())}.`;
		expect((await verifyAccessJwt(none, config, keys, now)).ok).toBe(false);
		const hs = await sign(claims(), { alg: 'HS256' });
		expect(await verifyAccessJwt(hs, config, keys, now)).toEqual({ ok: false, reason: 'unexpected alg HS256' });
	});

	test('rejects unknown kids and garbage', async () => {
		expect(await verifyAccessJwt(await sign(claims(), { kid: 'nope' }), config, keys, now)).toEqual({
			ok: false,
			reason: 'unknown kid nope'
		});
		expect((await verifyAccessJwt('not.a.jwt', config, keys, now)).ok).toBe(false);
		expect((await verifyAccessJwt('abc', config, keys, now)).ok).toBe(false);
		expect((await verifyAccessJwt('', config, keys, now)).ok).toBe(false);
	});
});

describe('teamKeys', () => {
	const certs = (calls: string[]) =>
		(async (url: string | URL | Request) => {
			calls.push(String(url));
			return Response.json({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] });
		}) as typeof fetch;

	test('fetches the team certs once and caches them', async () => {
		const calls: string[] = [];
		const lookup = teamKeys(config.issuer, certs(calls), new Map());
		expect(await lookup(KID)).not.toBe(null);
		expect(await lookup(KID)).not.toBe(null);
		expect(calls).toEqual(['https://team.cloudflareaccess.com/cdn-cgi/access/certs']);
	});

	test('an unknown kid right after a fetch does not refetch', async () => {
		const calls: string[] = [];
		const lookup = teamKeys(config.issuer, certs(calls), new Map());
		await lookup(KID);
		expect(await lookup('rotated')).toBe(null);
		expect(calls.length).toBe(1);
	});

	test('verifies a real token end to end through a request', async () => {
		const request = new Request('https://example.com/admin/pipeline', {
			headers: { 'Cf-Access-Jwt-Assertion': await sign(claims({ exp: Date.now() / 1000 + 60, nbf: undefined })) }
		});
		const result = await verifyAccessRequest(request, config, certs([]));
		expect(result.ok).toBe(true);
	});

	test('a request without the header, or failing certs, is refused', async () => {
		expect(await verifyAccessRequest(new Request('https://example.com/admin'), config)).toEqual({ ok: false, reason: 'no Access token' });
		const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
		const request = new Request('https://example.com/admin', {
			headers: { 'Cf-Access-Jwt-Assertion': await sign(claims(), { kid: 'fresh-kid' }) }
		});
		const result = await verifyAccessRequest(request, { ...config, issuer: 'https://other.cloudflareaccess.com' }, failing);
		expect(result.ok).toBe(false);
	});
});

describe('accessConfig', () => {
	test('normalises the team domain and needs both vars', () => {
		expect(accessConfig({ ACCESS_TEAM_DOMAIN: 'Team.cloudflareaccess.com', ACCESS_AUD: 'x' })).toEqual({
			issuer: 'https://team.cloudflareaccess.com',
			aud: 'x'
		});
		expect(accessConfig({ ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/', ACCESS_AUD: ' x ' })?.issuer).toBe(
			'https://team.cloudflareaccess.com'
		);
		expect(accessConfig({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: 'x' })).toBe(null);
		expect(accessConfig({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: '' })).toBe(null);
		expect(accessConfig({})).toBe(null);
	});
});
