import { Database } from 'bun:sqlite';
import type { Cookies } from '@sveltejs/kit';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from '../pipeline/d1-sqlite';
import { finishSignIn } from './callback';
import { setFlowCookie } from './cookies';
import { accountReader, CACHED_ROUTE_READ } from './locals';
import { authorizeUrl, challengeOf, decodeFlow, encodeFlow, exchangeCode, newFlow, safeReturn, type Flow } from './oauth';
import { enabledProviders, providerClient, SPECS } from './providers';
import {
	accountChores,
	createSession,
	hashToken,
	HINT_COOKIE,
	readSession,
	SESSION_DAYS,
	sessionCookieName,
	SESSIONS_PER_USER
} from './sessions';
import { accountProviders, cleanName, deleteAccount, NAME_HOLD_DAYS, nameProblem, renameAccount, signInAccount } from './users';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const DAY = 86_400_000;
const ENGINEER = /^Engineer [1-9]\d{3}$/;

/** The real migrations on an in-memory database, with factorioprints authors named Nilaus and "Kano!". */
const fresh = () => {
	const sqlite = new Database(':memory:');
	for (const f of readdirSync(join(ROOT, 'migrations'))
		.filter((f) => f.endsWith('.sql'))
		.sort())
		sqlite.run(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
	sqlite.run(
		`INSERT INTO authors (author_id, display_name, source, fetched_at) VALUES ('a1', 'Nilaus', 'record', 0), ('a2', '★ Kano! ★', 'record', 0)`
	);
	return { sqlite, db: d1FromSqlite(sqlite) };
};
const count = (sqlite: Database, table: string) => (sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A fetch that answers each URL from `routes` and records what it was asked. */
const fakeFetch = (routes: Record<string, () => Response>) => {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		const route = routes[url];
		if (!route) throw new Error(`unexpected fetch ${url}`);
		return route();
	}) as typeof fetch;
	return { calls, fetcher };
};

/** SvelteKit's Cookies, as far as the auth code uses them: what the request sent, and what the response sets. */
const fakeCookies = (sent: Record<string, string> = {}) => {
	const jar = new Map(Object.entries(sent));
	const deleted = new Set<string>();
	const cookies = {
		get: (name: string) => jar.get(name),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string) => {
			jar.set(name, value);
			deleted.delete(name);
		},
		delete: (name: string) => {
			jar.delete(name);
			deleted.add(name);
		},
		serialize: () => ''
	} as unknown as Cookies;
	return { cookies, jar, deleted };
};

describe('safeReturn', () => {
	test('keeps paths on this site', () => {
		expect(safeReturn('/prints/abc?page=2')).toBe('/prints/abc?page=2');
		expect(safeReturn('/?makes=item:gear')).toBe('/?makes=item:gear');
		expect(safeReturn('/account#uploads')).toBe('/account#uploads');
	});
	test('percent-encodes what a Location header can’t carry raw', () => {
		expect(safeReturn('/中')).toBe('/%E4%B8%AD');
		expect(safeReturn('/?q=中')).toBe('/?q=%E4%B8%AD');
	});
	test('refuses other origins, schemes and the sign-in routes', () => {
		for (const bad of [
			null,
			'',
			'prints/x',
			'https://evil.example',
			'//evil.example',
			'/\\evil.example',
			'/\\/evil.example',
			'/\t/evil.example',
			'javascript:alert(1)',
			'/auth/github',
			'/auth',
			'/login?return=/x',
			'/%2e%2e/auth/github',
			'/.//evil.com',
			'/..//evil.com',
			'/%2e//evil.com',
			'/./\\evil.com',
			`/${'x'.repeat(1000)}`
		]) {
			expect(safeReturn(bad)).toBe('/');
		}
	});
});

describe('the OAuth flow', () => {
	test('PKCE S256 matches RFC 7636', async () => {
		expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
	});

	test('the flow cookie round-trips, and anything else is refused', () => {
		const flow = newFlow('github', '/prints/x');
		expect(decodeFlow(encodeFlow(flow))).toEqual(flow);
		expect(flow.state).not.toBe(newFlow('github', null).state);
		expect(decodeFlow(undefined)).toBeNull();
		expect(decodeFlow('not base64 json')).toBeNull();
		expect(decodeFlow(btoa(JSON.stringify({ ...flow, provider: 'myspace' })))).toBeNull();
		// A tampered return path is cleaned again on the way out.
		expect(decodeFlow(btoa(JSON.stringify({ ...flow, returnTo: '//evil.example' })))?.returnTo).toBe('/');
	});

	test('the authorize URL carries the client, redirect, scope, state and challenge', async () => {
		const flow: Flow = { provider: 'google', state: 'st', verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', returnTo: '/' };
		const url = new URL(await authorizeUrl(flow, { id: 'cid', secret: 's' }, 'https://example.com'));
		expect(url.origin + url.pathname).toBe(SPECS.google.authorize);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			response_type: 'code',
			client_id: 'cid',
			redirect_uri: 'https://example.com/auth/google/callback',
			scope: 'openid',
			state: 'st',
			code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
			code_challenge_method: 'S256'
		});
		// GitHub asks for no scope (public profile only).
		const gh = new URL(await authorizeUrl({ ...flow, provider: 'github' }, { id: 'cid', secret: 's' }, 'https://example.com'));
		expect(gh.searchParams.has('scope')).toBe(false);
	});

	test('the code exchange sends the verifier and secret, and refuses an error answered with 200', async () => {
		const flow: Flow = { provider: 'github', state: 'st', verifier: 'v', returnTo: '/' };
		const ok = fakeFetch({ [SPECS.github.token]: () => Response.json({ access_token: 'tok', token_type: 'bearer' }) });
		expect(await exchangeCode(flow, 'code', { id: 'cid', secret: 'sec' }, 'https://example.com', ok.fetcher)).toBe('tok');
		const sent = Object.fromEntries(new URLSearchParams(String(ok.calls[0].init?.body)));
		expect(sent).toEqual({
			grant_type: 'authorization_code',
			code: 'code',
			redirect_uri: 'https://example.com/auth/github/callback',
			client_id: 'cid',
			client_secret: 'sec',
			code_verifier: 'v'
		});
		const refused = fakeFetch({ [SPECS.github.token]: () => Response.json({ error: 'bad_verification_code' }) });
		await expect(exchangeCode(flow, 'code', { id: 'cid', secret: 'sec' }, 'https://example.com', refused.fetcher)).rejects.toThrow(
			'github token: HTTP 200 bad_verification_code'
		);
	});

	test('each provider’s profile gives a permanent id and, for Discord and GitHub, the public handle', async () => {
		const { fetcher, calls } = fakeFetch({
			'https://discord.com/api/users/@me': () => Response.json({ id: '80351110224678912', username: 'nelly', global_name: 'Nelly ✨' }),
			'https://api.github.com/user': () => Response.json({ id: 583231, login: 'octocat', name: 'The Octocat' }),
			'https://openidconnect.googleapis.com/v1/userinfo': () => Response.json({ sub: '1100', name: 'Ada Lovelace', given_name: 'Ada' })
		});
		expect(await SPECS.discord.profile('t', fetcher)).toEqual({ subject: '80351110224678912', name: 'nelly' });
		expect(await SPECS.github.profile('t', fetcher)).toEqual({ subject: '583231', name: 'octocat' });
		// Google's names are people's own: none kept.
		expect(await SPECS.google.profile('t', fetcher)).toEqual({ subject: '1100', name: '' });
		expect(new Headers(calls[1].init?.headers).get('authorization')).toBe('Bearer t');
		// GitHub's API refuses requests without a User-Agent.
		expect(new Headers(calls[1].init?.headers).get('user-agent')).toBe('factorio-atlas');
	});

	test('a profile without an id, or a refused one, throws', async () => {
		const { fetcher } = fakeFetch({
			'https://discord.com/api/users/@me': () => Response.json({ username: 'nelly' }),
			'https://api.github.com/user': () => new Response('no', { status: 401 })
		});
		await expect(SPECS.discord.profile('t', fetcher)).rejects.toThrow('no user id');
		await expect(SPECS.github.profile('t', fetcher)).rejects.toThrow('HTTP 401');
	});

	test('a provider is on only with both its client id and secret', () => {
		const vars = {
			DISCORD_CLIENT_ID: 'd',
			DISCORD_CLIENT_SECRET: 'ds',
			GITHUB_CLIENT_ID: 'g',
			GITHUB_CLIENT_SECRET: '',
			GOOGLE_CLIENT_ID: ' '
		};
		expect(enabledProviders(vars)).toEqual(['discord']);
		expect(providerClient(vars, 'discord')).toEqual({ id: 'd', secret: 'ds' });
		expect(providerClient(vars, 'github')).toBeNull();
	});
});

describe('the callback', () => {
	const vars = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'sec' };
	const github = (login = 'octocat', id = 583231) =>
		fakeFetch({
			[SPECS.github.token]: () => Response.json({ access_token: 'tok' }),
			'https://api.github.com/user': () => Response.json({ id, login })
		});
	/** A browser that started signing in with `provider`, returning to /prints/x. */
	const started = (provider: Flow['provider'] = 'github', sent: Record<string, string> = {}) => {
		const c = fakeCookies(sent);
		const flow = newFlow(provider, '/prints/x');
		setFlowCookie(c.cookies, flow, true);
		return { ...c, flow };
	};
	const callback = (state: string, extra = '') => new URL(`https://example.com/auth/github/callback?code=c&state=${state}${extra}`);

	test('a matching state signs in: an account, a session, cookies, and /account for a new account', async () => {
		const { db, sqlite } = fresh();
		const { cookies, jar, flow } = started();
		const next = await finishSignIn('github', callback(flow.state), { db, vars, cookies, dev: true, fetcher: github().fetcher });
		expect(next).toBe(`/account?welcome=1&return=${encodeURIComponent('/prints/x')}`);
		expect(jar.get(HINT_COOKIE)).toBe('1');
		const token = jar.get(sessionCookieName(true)) ?? '';
		expect((await readSession(db, token))?.account.name).toBe('octocat');
		expect(jar.has('atlas_oauth')).toBe(false);
		expect(count(sqlite, 'users')).toBe(1);

		// Signing in again goes straight back, and ends the browser's previous session.
		const again = started('github', { [sessionCookieName(true)]: token });
		expect(
			await finishSignIn('github', callback(again.flow.state), { db, vars, cookies: again.cookies, dev: true, fetcher: github().fetcher })
		).toBe('/prints/x');
		expect(await readSession(db, token)).toBeNull();
		expect(count(sqlite, 'sessions')).toBe(1);
	});

	test('no flow cookie, another provider’s flow or another state: expired, and no account', async () => {
		const { db, sqlite } = fresh();
		const missing = fakeCookies();
		expect(await finishSignIn('github', callback('s'), { db, vars, cookies: missing.cookies, dev: true, fetcher: github().fetcher })).toBe(
			'/login?error=expired&return=%2F'
		);
		const other = started('discord');
		expect(
			await finishSignIn('github', callback(other.flow.state), { db, vars, cookies: other.cookies, dev: true, fetcher: github().fetcher })
		).toBe(`/login?error=expired&return=${encodeURIComponent('/prints/x')}`);
		const wrong = started();
		expect(
			await finishSignIn('github', callback('not-the-state'), { db, vars, cookies: wrong.cookies, dev: true, fetcher: github().fetcher })
		).toBe(`/login?error=expired&return=${encodeURIComponent('/prints/x')}`);
		expect(count(sqlite, 'users')).toBe(0);
		expect(wrong.deleted.has('atlas_oauth')).toBe(true);
	});

	test('an `error` from the provider is a cancel; a failing provider is reported; an unknown or unset provider is a 404', async () => {
		const { db } = fresh();
		const cancelled = started();
		const f = github();
		expect(
			await finishSignIn('github', callback(cancelled.flow.state, '&error=access_denied'), {
				db,
				vars,
				cookies: cancelled.cookies,
				dev: true,
				fetcher: f.fetcher
			})
		).toBe(`/login?error=cancelled&return=${encodeURIComponent('/prints/x')}`);
		expect(f.calls.length).toBe(0);
		const failing = started();
		const broken = fakeFetch({ [SPECS.github.token]: () => new Response('down', { status: 502 }) });
		expect(
			await finishSignIn('github', callback(failing.flow.state), { db, vars, cookies: failing.cookies, dev: true, fetcher: broken.fetcher })
		).toBe(`/login?error=provider&return=${encodeURIComponent('/prints/x')}`);
		expect(await finishSignIn('myspace', callback('s'), { db, vars, cookies: fakeCookies().cookies, dev: true })).toBeNull();
		expect(await finishSignIn('discord', callback('s'), { db, vars, cookies: fakeCookies().cookies, dev: true })).toBeNull();
	});

	test('a banned account lands on /login?error=banned with no session', async () => {
		const { db, sqlite } = fresh();
		await signInAccount(db, 'github', { subject: '583231', name: 'octocat' });
		sqlite.run(`UPDATE users SET banned_at = 1`);
		const { cookies, jar, flow } = started();
		expect(await finishSignIn('github', callback(flow.state), { db, vars, cookies, dev: true, fetcher: github().fetcher })).toBe(
			`/login?error=banned&return=${encodeURIComponent('/prints/x')}`
		);
		expect(jar.has(sessionCookieName(true))).toBe(false);
		expect(count(sqlite, 'sessions')).toBe(0);
	});
});

describe('locals.account', () => {
	test('throws on a cached route, without reading anything', () => {
		const { db } = fresh();
		const read = accountReader(db, fakeCookies().cookies, false, true);
		expect(() => read()).toThrow(CACHED_ROUTE_READ);
	});

	test('reads the session once per request, and clears a hint cookie that has no session', async () => {
		const { db } = fresh();
		const a = await signInAccount(db, 'github', { subject: '1', name: 'Ada' });
		const { token } = await createSession(db, a.ok ? a.account.id : '');
		const signedIn = fakeCookies({ [sessionCookieName(false)]: token, [HINT_COOKIE]: '1' });
		const read = accountReader(db, signedIn.cookies, false, false);
		expect(read()).toBe(read());
		expect((await read())?.name).toBe('Ada');
		expect(signedIn.deleted.size).toBe(0);

		const stale = fakeCookies({ [HINT_COOKIE]: '1' });
		expect(await accountReader(db, stale.cookies, false, false)()).toBeNull();
		expect(stale.deleted.has(HINT_COOKIE)).toBe(true);

		const expired = fakeCookies({ [sessionCookieName(false)]: 'gone', [HINT_COOKIE]: '1' });
		expect(await accountReader(db, expired.cookies, false, false)()).toBeNull();
		expect([...expired.deleted].sort()).toEqual([sessionCookieName(false), HINT_COOKIE].sort());
	});

	test('a refreshed session sets its cookies again', async () => {
		const { db } = fresh();
		const a = await signInAccount(db, 'github', { subject: '1', name: 'Ada' });
		const { token } = await createSession(db, a.ok ? a.account.id : '', Date.now() - 20 * DAY);
		const c = fakeCookies({ [sessionCookieName(false)]: token });
		await accountReader(db, c.cookies, false, false)();
		expect(c.jar.get(HINT_COOKIE)).toBe('1');
	});
});

describe('account names', () => {
	test('from a handle: ASCII letters, digits, spaces and _.- only, letters or digits at both ends', () => {
		expect(cleanName('  Ada   <b>Lovelace</b>!! ')).toBe('Ada bLovelaceb');
		expect(cleanName('ｆｕｌｌ width')).toBe('full width');
		expect(cleanName('Nilаus')).toBe('Nilus'); // Cyrillic а dropped, never kept as a look-alike
		expect(cleanName('__x__')).toBe('x');
		expect(cleanName('x'.repeat(40))).toBe('x'.repeat(32));
		expect(cleanName('🙂'.repeat(40))).toBe('');
	});
	test('typed by the owner: refused, never silently changed', () => {
		expect(nameProblem('a')).not.toBeNull();
		expect(nameProblem('__')).not.toBeNull();
		expect(nameProblem('-Ada')).not.toBeNull();
		expect(nameProblem('Nilаus')).toContain('isn’t allowed');
		expect(nameProblem('Zoë')).toContain('isn’t allowed');
		expect(nameProblem('x'.repeat(33))).not.toBeNull();
		expect(nameProblem('Admin')).toBe('That name is reserved.');
		expect(nameProblem('Ada')).toBeNull();
		expect(nameProblem('  Ada   L. Lovelace ')).toBeNull();
		expect(nameProblem('a.b_c-d 9')).toBeNull();
	});
});

describe('accounts', () => {
	test('the first sign-in makes an account, later ones find it', async () => {
		const { db } = fresh();
		const first = await signInAccount(db, 'github', { subject: '1', name: 'octocat' }, 1);
		expect(first).toMatchObject({ ok: true, created: true, account: { name: 'octocat' } });
		const again = await signInAccount(db, 'github', { subject: '1', name: 'renamed-at-github' }, 2);
		expect(again).toEqual({ ok: true, created: false, account: first.ok ? first.account : { id: '', name: '' } });
		// The same id at another provider is another person.
		expect(await signInAccount(db, 'discord', { subject: '1', name: 'octocat' }, 3)).toMatchObject({
			ok: true,
			created: true,
			account: { name: 'octocat 2' }
		});
		expect(await accountProviders(db, first.ok ? first.account.id : '')).toEqual(['github']);
	});

	test('names never repeat (ignoring case), never take a factorioprints author’s, and fall back to Engineer NNNN', async () => {
		const { db } = fresh();
		const name = async (subject: string, n: string) => {
			const r = await signInAccount(db, 'github', { subject, name: n });
			return r.ok ? r.account.name : null;
		};
		expect(await name('1', 'nilaus')).toBe('nilaus 2');
		// "★ Kano! ★" stripped to the allowed characters is "Kano".
		expect(await name('2', 'KANO')).toBe('KANO 2');
		expect(await name('3', 'Ada')).toBe('Ada');
		expect(await name('4', 'ADA')).toBe('ADA 2');
		expect(ENGINEER.test(String(await name('5', '🙂')))).toBe(true);
		expect(ENGINEER.test(String(await name('6', 'admin')))).toBe(true);
		// Google gives no name.
		const g = await signInAccount(db, 'google', { subject: '7', name: '' });
		expect(ENGINEER.test(g.ok ? g.account.name : '')).toBe(true);
	});

	test('renaming checks the same rules, lets an account change its own name’s case, and reports only real clashes as taken', async () => {
		const { db } = fresh();
		const a = await signInAccount(db, 'github', { subject: '1', name: 'Ada' });
		await signInAccount(db, 'github', { subject: '2', name: 'Grace' });
		const id = a.ok ? a.account.id : '';
		expect(await renameAccount(db, id, 'grace')).toEqual({ ok: false, problem: 'That name is taken.' });
		expect(await renameAccount(db, id, 'NILAUS')).toEqual({ ok: false, problem: 'That name is taken.' });
		expect(await renameAccount(db, id, 'kano')).toEqual({ ok: false, problem: 'That name is taken.' });
		expect(await renameAccount(db, id, 'x')).toMatchObject({ ok: false });
		const lookalike = await renameAccount(db, id, 'Gracе');
		expect(!lookalike.ok && lookalike.problem.includes('isn’t allowed')).toBe(true);
		expect(await renameAccount(db, id, 'ADA')).toEqual({ ok: true, name: 'ADA' });
		expect(await renameAccount(db, id, ' Ada  L. ')).toEqual({ ok: true, name: 'Ada L.' });
		const broken = {
			prepare: db.prepare.bind(db),
			batch: () => Promise.reject(new Error('D1_ERROR: network lost'))
		} as unknown as D1Database;
		await expect(renameAccount(broken, id, 'Ada Lovelace')).rejects.toThrow('network lost');
	});

	test('a name given up is held for 30 days: only its old account may take it back', async () => {
		const { db, sqlite } = fresh();
		const t0 = 1_000_000;
		const a = await signInAccount(db, 'github', { subject: '1', name: 'Ada' }, t0);
		const b = await signInAccount(db, 'github', { subject: '2', name: 'Grace' }, t0);
		const [aId, bId] = [a.ok ? a.account.id : '', b.ok ? b.account.id : ''];
		expect(await renameAccount(db, aId, 'Ada L', t0)).toMatchObject({ ok: true });
		expect(await renameAccount(db, bId, 'ada', t0 + DAY)).toEqual({ ok: false, problem: 'That name is taken.' });
		expect((await signInAccount(db, 'discord', { subject: '3', name: 'Ada' }, t0 + DAY)).ok && 'made').toBe('made');
		expect(sqlite.query(`SELECT name FROM users WHERE id NOT IN (?, ?)`).get(aId, bId)).toEqual({ name: 'Ada 2' });
		// Its own account may take it back at once, which ends the hold.
		expect(await renameAccount(db, aId, 'Ada', t0 + 2 * DAY)).toEqual({ ok: true, name: 'Ada' });
		expect(await renameAccount(db, aId, 'Ada L', t0 + 3 * DAY)).toMatchObject({ ok: true });
		// After the hold anyone may.
		expect(await renameAccount(db, bId, 'ada', t0 + 3 * DAY + NAME_HOLD_DAYS * DAY + 1)).toEqual({ ok: true, name: 'ada' });

		// A deleted account's name is held too.
		await deleteAccount(db, aId, t0 + 40 * DAY);
		expect(await renameAccount(db, bId, 'Ada L', t0 + 41 * DAY)).toEqual({ ok: false, problem: 'That name is taken.' });
		// The daily chores drop holds past their 30 days.
		await accountChores(db, t0 + 41 * DAY);
		// Left: Grace (given up on day 33) and Ada L (day 40); Ada (day 3) went.
		expect(count(sqlite, 'released_names')).toBe(2);
		await accountChores(db, t0 + 71 * DAY);
		expect(count(sqlite, 'released_names')).toBe(0);
	});

	test('a banned account can’t sign in, and its sessions stop', async () => {
		const { db, sqlite } = fresh();
		const a = await signInAccount(db, 'discord', { subject: '9', name: 'Spammer' });
		const id = a.ok ? a.account.id : '';
		const { token } = await createSession(db, id);
		sqlite.query(`UPDATE users SET banned_at = 1 WHERE id = ?`).run(id);
		expect(await signInAccount(db, 'discord', { subject: '9', name: 'Spammer' })).toEqual({ ok: false, reason: 'banned' });
		expect(await readSession(db, token)).toBeNull();
		expect(count(sqlite, 'sessions')).toBe(0);
	});

	test('deleting an account removes its sign-ins and sessions', async () => {
		const { db, sqlite } = fresh();
		const a = await signInAccount(db, 'discord', { subject: '9', name: 'Ada' });
		const id = a.ok ? a.account.id : '';
		const { token } = await createSession(db, id);
		await deleteAccount(db, id);
		expect(await readSession(db, token)).toBeNull();
		for (const table of ['users', 'user_identities', 'sessions']) expect(count(sqlite, table)).toBe(0);
		// The provider account can sign up again, as a new account (its old name is held, even from it).
		expect(await signInAccount(db, 'discord', { subject: '9', name: 'Ada' })).toMatchObject({
			ok: true,
			created: true,
			account: { name: 'Ada 2' }
		});
	});
});

describe('sessions', () => {
	test('store only the token’s hash, and read back the account', async () => {
		const { db, sqlite } = fresh();
		const a = await signInAccount(db, 'github', { subject: '1', name: 'Ada' });
		const id = a.ok ? a.account.id : '';
		const { token, expiresAt } = await createSession(db, id, 1_000);
		expect(expiresAt).toBe(1_000 + SESSION_DAYS * DAY);
		expect(sqlite.query(`SELECT token_hash FROM sessions`).get()).toEqual({ token_hash: await hashToken(token) });
		expect(JSON.stringify(sqlite.query(`SELECT * FROM sessions`).all())).not.toContain(token);
		expect(await readSession(db, token, 2_000)).toEqual({ account: { id, name: 'Ada' }, expiresAt, refreshed: false });
		expect(await readSession(db, `${token}x`, 2_000)).toBeNull();
	});

	test('are extended once under half their life is left, and end when expired', async () => {
		const { db, sqlite } = fresh();
		const a = await signInAccount(db, 'github', { subject: '1', name: 'Ada' });
		const id = a.ok ? a.account.id : '';
		const { token, expiresAt } = await createSession(db, id, 0);
		const late = expiresAt - 10 * DAY;
		expect(await readSession(db, token, late)).toMatchObject({ expiresAt: late + SESSION_DAYS * DAY, refreshed: true });
		expect(await readSession(db, token, late + 1)).toMatchObject({ refreshed: false });
		expect(await readSession(db, token, late + SESSION_DAYS * DAY)).toBeNull();
		expect(count(sqlite, 'sessions')).toBe(0);
	});

	test('an account keeps only its newest sessions; the daily chores delete expired ones', async () => {
		const { db, sqlite } = fresh();
		const a = await signInAccount(db, 'github', { subject: '1', name: 'Ada' });
		const id = a.ok ? a.account.id : '';
		const tokens: string[] = [];
		for (let i = 0; i < SESSIONS_PER_USER + 5; i++) tokens.push((await createSession(db, id, 1_000 + i)).token);
		expect(count(sqlite, 'sessions')).toBe(SESSIONS_PER_USER);
		expect(await readSession(db, tokens[0], 2_000)).toBeNull();
		expect(await readSession(db, tokens.at(-1) ?? '', 2_000)).not.toBeNull();
		await accountChores(db, 1_000 + SESSION_DAYS * DAY + 10);
		// The 20 kept were made at 1,005 … 1,024 ms; those made up to 1,010 have expired.
		expect(count(sqlite, 'sessions')).toBe(SESSIONS_PER_USER - 6);
	});

	test('the daily chores never throw', async () => {
		const broken = { prepare: () => ({ bind: () => ({}) }), batch: () => Promise.reject(new Error('down')) } as unknown as D1Database;
		expect(await accountChores(broken)).toBeUndefined();
	});
});
