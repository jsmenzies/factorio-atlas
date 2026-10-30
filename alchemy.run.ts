/**
 * Cloudflare infrastructure, provisioned by Alchemy (https://alchemy.run). Runbook: docs/deploy.md.
 *
 *   bun run plan:prod      # vite build, then `alchemy plan --stage prod`: preview the changes
 *   bun run deploy:prod    # vite build, then `alchemy deploy --stage prod`
 *
 * One deployed stage, `prod` (STAGES in infra/databases.ts; local development runs on miniflare
 * with `bun run dev`), with its own Worker (the SvelteKit app, built by adapter-cloudflare exactly
 * as `bun run preview` runs it), D1 database and three R2 buckets, plus a small scheduled Worker that
 * totals page views into D1 daily (with ANALYTICS_API_TOKEN). Prod also owns the one sprites
 * bucket. A staging stage can be added to STAGES; it gets the same resources and links to prod's
 * sprites bucket.
 * Binding names (DB, RAW, RENDERS, SPRITES, SCREENSHOTS, VIEWS), the rate limits (PAGE_LIMIT, SEARCH_LIMIT, AUTH_LIMIT, UPLOAD_LIMIT), vars,
 * compatibility date and flags come from wrangler.jsonc,
 * which stays the config for local tooling (`vite dev`, `wrangler d1 --local`, `wrangler types`,
 * scripts/ingest.ts), so local and deployed Workers can't drift apart. Alchemy adds ASSETS.
 *
 * Physical names include the stage: Worker `factorio-prints-<stage>`, D1
 * `factorio-prints-<stage>-db-<generation>`, R2 `factorio-prints-<stage>-raw`, `-renders` and `-screenshots`, and the
 * shared R2 `factorio-prints-sprites`.
 * The prefix is fixed and also names the Alchemy stack, so renaming the site or the repo never
 * replaces resources.
 */
import * as rulesets from '@distilled.cloud/cloudflare/rulesets';
import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import { Config, Effect, Option } from 'effect';
import { unstable_readConfig } from 'wrangler';
import { DATABASES, PREFIX, screenshotsBucket, SPRITES_BUCKET, STAGES, viewsDataset, type Stage } from './infra/databases';

/** The parts of wrangler.jsonc used here (wrangler's own config type isn't exported). */
interface LocalConfig {
	compatibility_date: string;
	compatibility_flags: string[];
	vars: Record<string, unknown>;
	d1_databases: { binding: string }[];
	r2_buckets: { binding: string }[];
	ratelimits: { name: string; namespace_id: string; simple: { limit: number; period: 10 | 60 } }[];
	analytics_engine_datasets: { binding: string }[];
}
const local: LocalConfig = unstable_readConfig({ config: 'wrangler.jsonc' }, { hideWarnings: true });

// Fail fast if wrangler.jsonc gains a binding this file doesn't provision.
const expected = {
	d1: ['DB'],
	r2: ['RAW', 'RENDERS', 'SPRITES', 'SCREENSHOTS'],
	ratelimits: ['PAGE_LIMIT', 'SEARCH_LIMIT', 'AUTH_LIMIT', 'REPORT_LIMIT', 'UPLOAD_LIMIT'],
	analytics: ['VIEWS']
};
const actual = {
	d1: local.d1_databases.map((d) => d.binding),
	r2: local.r2_buckets.map((b) => b.binding),
	ratelimits: local.ratelimits.map((r) => r.name),
	analytics: local.analytics_engine_datasets.map((a) => a.binding)
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
	throw new Error(`wrangler.jsonc bindings ${JSON.stringify(actual)} differ from alchemy.run.ts ${JSON.stringify(expected)}`);
}
/** Names our one cache rule; every other rule in the zone's cache-rules phase stops a deploy. */
const CACHE_RULE = 'Cache sprites and renders, keeping their own cache-control';
/** Names our one WAF rate-limiting rule; likewise for the zone's rate-limit phase. */
const FLOOD_RULE = 'Block floods on the site';

/**
 * Prod owns the whole of these zone phases (a Ruleset is the phase's entire rule list), so a deploy
 * would delete any rule made elsewhere, e.g. in the dashboard. Stop first when the phase holds a
 * rule not named `ours`.
 */
const ownPhase = (zoneId: string, rulesetPhase: 'http_request_cache_settings' | 'http_ratelimit', ours: string) =>
	rulesets.getPhasForZone({ zoneId, rulesetPhase }).pipe(
		Effect.map((ruleset) => ruleset.rules ?? []),
		Effect.catchTag('RulesetNotFound', () => Effect.succeed([])),
		Effect.orDie,
		Effect.flatMap((existing) => {
			const foreign = existing.filter((rule) => rule.description !== ours);
			if (foreign.length === 0) return Effect.void;
			const list = foreign.map((rule) => `"${rule.description ?? ''}" (${rule.expression ?? ''})`).join(', ');
			return Effect.die(
				new Error(
					`The zone's ${rulesetPhase} rules include ${list}, which this deploy would delete. Add them to that ruleset in alchemy.run.ts, or remove them from the zone, then deploy again.`
				)
			);
		})
	);

const vars = Object.fromEntries(
	Object.entries(local.vars).map(([key, value]) => {
		if (typeof value !== 'string') throw new Error(`wrangler.jsonc var ${key} must be a string`);
		return [key, value];
	})
);

export default Alchemy.Stack(
	PREFIX,
	{
		providers: Cloudflare.providers(),
		// Shared state in the Cloudflare account (a Worker + Durable Object, bootstrapped on the
		// first deploy), so two machines and a GitHub Action see the same state.
		state: Cloudflare.state()
	},
	Effect.gen(function* () {
		const stage = yield* Alchemy.Stage;
		if (!STAGES.includes(stage as Stage)) {
			return yield* Effect.die(new Error(`Unknown stage "${stage}": pass --stage ${STAGES.join(' or --stage ')} (infra/databases.ts)`));
		}
		const name = `${PREFIX}-${stage}`;
		const { bound, importTarget } = DATABASES[stage as Stage];

		// Data-bearing resources are retained: deleting them from this file, `alchemy destroy` or a
		// generation swap only makes Alchemy forget them. Delete them by hand when sure. The D1 of any
		// stage other than prod (a staging stage added to STAGES) is the exception, so `alchemy
		// destroy` cleans it up and its swapped-out generations go away.
		const database = (generation: number) =>
			Cloudflare.D1.Database(`Db${generation}`, {
				name: `${name}-db-${generation}`,
				// Applied on deploy, before the Worker is updated. Tracked in __alchemy_migrations;
				// wrangler's d1_migrations history is converted once if present.
				migrations: './migrations'
			}).pipe(Alchemy.RemovalPolicy.retain(stage === 'prod'));
		const db = yield* database(bound);
		if (importTarget !== undefined) yield* database(importTarget);

		const raw = yield* Cloudflare.R2.Bucket('Raw', { name: `${name}-raw` }).pipe(Alchemy.RemovalPolicy.retain());

		// Game renders (`bun run render --upload`). With RENDERS_DOMAIN_<STAGE> (e.g. renders.example.com,
		// a zone in the account) the bucket is public on that hostname only, so the viewer's images come
		// through Cloudflare's cache and never invoke the Worker. Every image's name changes when its
		// pixels do (tiles by pixel hash, overviews by render stamp), so they are uploaded with
		// `cache-control: immutable` and never need purging. Unset, the Worker serves them at
		// /prints/<id>/render/<file>.
		const rendersDomain = Option.getOrUndefined(yield* Config.option(Config.String(`RENDERS_DOMAIN_${stage.toUpperCase()}`)));
		const renders = yield* Cloudflare.R2.Bucket('Renders', {
			name: `${name}-renders`,
			domains: rendersDomain === undefined ? [] : [{ name: rendersDomain, minTLS: '1.2' }],
			cors: [{ allowedMethods: ['GET', 'HEAD'], allowedOrigins: ['*'], maxAgeSeconds: 86400 }]
		}).pipe(Alchemy.RemovalPolicy.retain());

		// Copies of the prints' Imgur screenshots (`bun run screenshots --upload`; src/lib/screenshots.ts),
		// served the same way: with SCREENSHOTS_DOMAIN_<STAGE> (e.g. screenshots.example.com) the bucket is
		// public on that hostname only, through Cloudflare's cache. Image names never change their bytes
		// (`immutable`); each image's manifest is kept 300 s. Unset, the Worker serves them at
		// /screenshots/<key>.
		const screenshotsDomain = Option.getOrUndefined(yield* Config.option(Config.String(`SCREENSHOTS_DOMAIN_${stage.toUpperCase()}`)));
		const screenshots = yield* Cloudflare.R2.Bucket('Screenshots', {
			name: screenshotsBucket(stage as Stage),
			domains: screenshotsDomain === undefined ? [] : [{ name: screenshotsDomain, minTLS: '1.2' }],
			cors: [{ allowedMethods: ['GET', 'HEAD'], allowedOrigins: ['*'], maxAgeSeconds: 86400 }]
		}).pipe(Alchemy.RemovalPolicy.retain());

		// Print page views (one data point each), totalled into D1 daily by the ViewsCron Worker below
		// (or `bun run views:sync`). Cloudflare creates the dataset on the first write; nothing to
		// retain or delete.
		const views = yield* Cloudflare.AnalyticsEngine.Dataset('Views', { dataset: viewsDataset(stage as Stage) });

		// Optional custom domain, SITE_DOMAIN_<STAGE>, e.g. SITE_DOMAIN_PROD=example.com (in .env or
		// the shell). The zone must already be in the account. Unset leaves domains
		// unmanaged; it never detaches one.
		const domain = Option.getOrUndefined(yield* Config.option(Config.String(`SITE_DOMAIN_${stage.toUpperCase()}`)));

		// Game art served as static files (icons from `bun run icons`; sprite atlases later), in ONE
		// bucket shared by every stage: keys are content-hashed and never change, so stages can't
		// disturb each other. Prod owns it (only prod declares it, so two stacks never fight over
		// it); other stages just link to SPRITES_DOMAIN. With SPRITES_DOMAIN (e.g. sprites.example.com,
		// a zone in the account) the bucket is public on that hostname only, so browsers fetch
		// through Cloudflare's cache and never invoke the Worker; objects carry `cache-control:
		// immutable`. Unset, prod's Worker serves the files at /sprites/<key> and other stages have
		// no icons. CORS lets a canvas or WebGL viewer on the site read the pixels.
		const spritesDomain = Option.getOrUndefined(yield* Config.option(Config.String('SPRITES_DOMAIN')));
		const sprites =
			stage === 'prod'
				? yield* Cloudflare.R2.Bucket('Sprites', {
						name: SPRITES_BUCKET,
						domains: spritesDomain === undefined ? [] : [{ name: spritesDomain, minTLS: '1.2' }],
						cors: [{ allowedMethods: ['GET', 'HEAD'], allowedOrigins: ['*'], maxAgeSeconds: 86400 }]
					}).pipe(Alchemy.RemovalPolicy.retain())
				: undefined;

		// Cloudflare caches only some file types by default (not .json, for one). One cache rule makes everything on
		// the sprites, renders and screenshots hostnames eligible, keeping each object's own cache-control (a year
		// and immutable for images, minutes for index.json), and Smart Tiered Cache sends misses to one
		// upper-tier data centre before R2. Prod owns these: the rule list is the zone's whole
		// cache-rules phase, and the zone's tiered-cache setting. A deploy would delete any cache rule
		// made elsewhere on the zone, so it stops first when the phase holds a rule other than ours.
		const cachedHosts = [stage === 'prod' ? spritesDomain : undefined, rendersDomain, screenshotsDomain].filter(
			(h): h is string => h !== undefined
		);
		// The zone a takedown purges (src/lib/server/takedown.ts), set below when there is a cache rule.
		let cacheZoneId: string | undefined;
		if (stage === 'prod' && cachedHosts.length > 0) {
			const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
			const zoneIds = yield* Effect.forEach(cachedHosts, (hostname) =>
				Cloudflare.Zone.resolveZoneId({ accountId, zone: undefined, hostname }).pipe(Effect.orDie)
			);
			const zoneId = zoneIds[0];
			if (zoneIds.some((z) => z !== zoneId)) {
				return yield* Effect.die(new Error(`${cachedHosts.join(' and ')} must be in one zone for the cache rule`));
			}
			cacheZoneId = zoneId;
			yield* ownPhase(zoneId, 'http_request_cache_settings', CACHE_RULE);
			yield* Cloudflare.Ruleset.Ruleset('CacheRules', {
				zone: { zoneId } as unknown as Cloudflare.Zone.Zone,
				phase: 'http_request_cache_settings',
				rules: [
					{
						description: CACHE_RULE,
						expression: `(http.host in {${cachedHosts.map((h) => JSON.stringify(h)).join(' ')}})`,
						action: 'set_cache_settings',
						actionParameters: { cache: true, edgeTtl: { mode: 'respect_origin' }, browserTtl: { mode: 'respect_origin' } }
					}
				]
			});
			yield* Cloudflare.Cache.SmartTieredCache('TieredCache', { zoneId });
		}

		// One WAF rate-limiting rule (the Free plan's one; docs/deploy.md, "Rate limits"): a backstop
		// against floods on the site's hostname, at the edge, so blocked requests never run (or bill)
		// the Worker. Steady scraping is the Worker's own PAGE_LIMIT and SEARCH_LIMIT. The Free plan
		// fixes the rest: counted per IP and data centre over 10 s, blocked for 10 s. /_app/ (the
		// build's scripts and styles, many per first visit) doesn't count. Prod owns the zone's
		// rate-limit phase, as with the cache rule.
		if (stage === 'prod' && domain !== undefined) {
			const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
			const zoneId = yield* Cloudflare.Zone.resolveZoneId({ accountId, zone: undefined, hostname: domain }).pipe(Effect.orDie);
			yield* ownPhase(zoneId, 'http_ratelimit', FLOOD_RULE);
			yield* Cloudflare.Ruleset.Ruleset('RateLimitRules', {
				zone: { zoneId } as unknown as Cloudflare.Zone.Zone,
				phase: 'http_ratelimit',
				rules: [
					{
						description: FLOOD_RULE,
						expression: `(http.host eq ${JSON.stringify(domain)} and not starts_with(http.request.uri.path, "/_app/"))`,
						action: 'block',
						ratelimit: { characteristics: ['ip.src', 'cf.colo.id'], period: 10, requestsPerPeriod: 60, mitigationTimeout: 10 }
					}
				]
			});
			// Bot Fight Mode (Free plan): challenges traffic Cloudflare is sure is automated; verified
			// bots (search engines, link previews) pass. It covers the whole zone and can't be skipped
			// per path. Only this field is written, so the zone's AI-crawler settings stay as they are;
			// removing it restores the setting it had before.
			yield* Cloudflare.BotManagement.BotManagement('Bots', { zoneId, fightMode: true });
		}

		// /admin (docs/deploy.md, "Admin page"): a Cloudflare Access application on `<domain>/admin*`
		// that lets in only ADMIN_EMAIL, and the Worker re-checks Access's JWT against the team domain
		// and this application's AUD (src/lib/server/admin/access.ts). The rest of the site stays
		// public. Needs the domain plus ACCESS_TEAM_DOMAIN (`<team>.cloudflareaccess.com`, from Zero
		// Trust) and ADMIN_EMAIL, in .env or CI secrets; never hard-code the email here. Without them
		// no application exists (a deploy without them removes it) and the Worker 404s /admin.
		const optional = (key: string) => Config.option(Config.String(key)).pipe(Effect.map(Option.getOrUndefined));
		const teamDomain = yield* optional('ACCESS_TEAM_DOMAIN');
		const adminEmail = yield* optional('ADMIN_EMAIL');
		const admin =
			domain !== undefined && teamDomain !== undefined && adminEmail !== undefined
				? yield* Cloudflare.Access.Application('Admin', {
						type: 'self_hosted',
						name: `${name} admin`,
						domain: `${domain}/admin*`,
						sessionDuration: '24h',
						appLauncherVisible: false,
						policies: [{ name: 'Admin only', decision: 'allow', include: [{ email: adminEmail }] }]
					})
				: undefined;
		if (admin === undefined) {
			yield* Effect.logWarning(
				`/admin is off on ${stage}: it needs SITE_DOMAIN_${stage.toUpperCase()}, ACCESS_TEAM_DOMAIN and ADMIN_EMAIL (docs/deploy.md, "Admin page")`
			);
		}

		// Removal requests and uploads (docs/deploy.md, "Removal requests"): Turnstile on their forms needs
		// TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY (without them the forms are off, never left unguarded);
		// a takedown purges the renders and screenshots domains' edge cache with CACHE_PURGE_TOKEN (Zone →
		// Cache Purge on that zone; without it the admin page lists what to purge by hand).
		const turnstileSiteKey = yield* optional('TURNSTILE_SITE_KEY');
		const turnstileSecret = Option.getOrUndefined(yield* Config.option(Config.Redacted('TURNSTILE_SECRET_KEY')));
		const turnstile = turnstileSiteKey !== undefined && turnstileSecret !== undefined;
		if (!turnstile) {
			yield* Effect.logWarning(
				`removal requests and uploads are off on ${stage}: they need TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY (docs/deploy.md, "Removal requests")`
			);
		}
		const purgeToken = Option.getOrUndefined(yield* Config.option(Config.Redacted('CACHE_PURGE_TOKEN')));
		if (cacheZoneId !== undefined && purgeToken === undefined) {
			yield* Effect.logWarning(
				`takedowns won't purge the edge cache on ${stage}: it needs CACHE_PURGE_TOKEN (docs/deploy.md, "Removal requests")`
			);
		}

		// Sign-in (docs/deploy.md, "Sign-in"; src/lib/server/auth/providers.ts): each provider's app client id and
		// secret, the secret bound as a Worker secret. A provider missing either is off; with none, nobody can
		// sign in. Each app's redirect URL is https://<SITE_DOMAIN_<STAGE>>/auth/<provider>/callback.
		const signIn: Record<string, unknown> = {};
		for (const provider of ['DISCORD', 'GITHUB', 'GOOGLE']) {
			const id = yield* optional(`${provider}_CLIENT_ID`);
			const secret = Option.getOrUndefined(yield* Config.option(Config.Redacted(`${provider}_CLIENT_SECRET`)));
			if (id === undefined || secret === undefined) {
				yield* Effect.logWarning(
					`sign-in with ${provider.toLowerCase()} is off on ${stage}: it needs ${provider}_CLIENT_ID and ${provider}_CLIENT_SECRET`
				);
				continue;
			}
			signIn[`${provider}_CLIENT_ID`] = id;
			signIn[`${provider}_CLIENT_SECRET`] = secret;
		}

		// What a purge (src/lib/server/takedown.ts) needs, for the site Worker and the cron's deletions: the
		// domains whose edge cache it purges, and the zone and token to purge with.
		const purgeEnv = {
			RENDERS_URL: rendersDomain === undefined ? '' : `https://${rendersDomain}`,
			SCREENSHOTS_URL: screenshotsDomain === undefined ? '' : `https://${screenshotsDomain}`,
			CACHE_ZONE_ID: purgeToken !== undefined && cacheZoneId !== undefined ? cacheZoneId : '',
			...(purgeToken !== undefined && cacheZoneId !== undefined ? { CACHE_PURGE_TOKEN: purgeToken } : {})
		};

		const worker = yield* Cloudflare.Worker('Site', {
			name,
			// Built by `vite build` (adapter-cloudflare), then bundled by Alchemy as wrangler would.
			main: './.svelte-kit/cloudflare/_worker.js',
			// Honours the adapter's .assetsignore, _headers and _redirects. Binding name: ASSETS.
			assets: { directory: './.svelte-kit/cloudflare' },
			compatibility: { date: local.compatibility_date, flags: local.compatibility_flags },
			// No preview URLs. workers.dev only while there is no custom domain: it would bypass the
			// zone's WAF rule and edge cache.
			workersDev: { enabled: domain === undefined, previewsEnabled: false },
			domain,
			env: {
				DB: db,
				RAW: raw,
				RENDERS: renders,
				SCREENSHOTS: screenshots,
				VIEWS: views,
				...(sprites ? { SPRITES: sprites } : {}),
				...Object.fromEntries(
					local.ratelimits.map((r) => [r.name, Cloudflare.RateLimit(r.name, { namespaceId: r.namespace_id, simple: r.simple })])
				),
				...vars,
				SPRITES_URL: spritesDomain === undefined ? '' : `https://${spritesDomain}`,
				...purgeEnv,
				// Empty (in wrangler.jsonc) means /admin is a 404 on this stage.
				ACCESS_TEAM_DOMAIN: admin ? (teamDomain ?? '') : '',
				ACCESS_AUD: admin ? admin.aud : '',
				// Never wrangler.jsonc's test key in a deployed stage.
				TURNSTILE_SITE_KEY: turnstile ? turnstileSiteKey : '',
				...(turnstile ? { TURNSTILE_SECRET_KEY: turnstileSecret } : {}),
				...signIn
			}
		});

		// The daily jobs (src/cron/views.ts): its own Worker, since the site's adapter-cloudflare Worker has
		// no scheduled handler. The views rollup reads the dataset through the Analytics Engine SQL API, so it
		// needs ANALYTICS_API_TOKEN (Account Analytics: Read; docs/deploy.md, "Page views"), bound as a
		// secret. Unset, there is no cron and `bun run views:sync` does it by hand. It also finishes account
		// deletions their owners left part-way, through the site's own gate and purge: the same buckets, vars,
		// compatibility flags and purge token as the site Worker.
		const analyticsToken = Option.getOrUndefined(yield* Config.option(Config.Redacted('ANALYTICS_API_TOKEN')));
		if (analyticsToken === undefined) {
			yield* Effect.logWarning(`the daily views rollup is off on ${stage}: it needs ANALYTICS_API_TOKEN (docs/deploy.md, "Page views")`);
		} else {
			const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
			yield* Cloudflare.Worker('ViewsCron', {
				name: `${name}-views-cron`,
				main: './src/cron/views.ts',
				compatibility: { date: local.compatibility_date, flags: local.compatibility_flags },
				workersDev: { enabled: false, previewsEnabled: false },
				// 04:17 UTC daily.
				crons: ['17 4 * * *'],
				env: {
					DB: db,
					ANALYTICS_API_TOKEN: analyticsToken,
					ACCOUNT_ID: accountId,
					VIEWS_DATASET: viewsDataset(stage as Stage),
					RAW: raw,
					RENDERS: renders,
					SCREENSHOTS: screenshots,
					MIRROR_BASE_URL: vars.MIRROR_BASE_URL,
					FIREBASE_BASE_URL: vars.FIREBASE_BASE_URL,
					...purgeEnv
				}
			});
		}

		return {
			url: worker.url,
			database: db.databaseName,
			importTarget: importTarget === undefined ? undefined : `${name}-db-${importTarget}`,
			buckets: [raw.bucketName, renders.bucketName, screenshots.bucketName, ...(sprites ? [sprites.bucketName] : [])],
			sprites: spritesDomain === undefined ? undefined : `https://${spritesDomain}`,
			renders: rendersDomain === undefined ? undefined : `https://${rendersDomain}`,
			screenshots: screenshotsDomain === undefined ? undefined : `https://${screenshotsDomain}`,
			admin: admin === undefined ? undefined : `https://${domain}/admin/pipeline`
		};
	})
);
