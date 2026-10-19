/**
 * Cloudflare infrastructure, provisioned by Alchemy (https://alchemy.run). Runbook: docs/deploy.md.
 *
 *   bun run deploy:dev     # vite build, then `alchemy deploy --stage dev`
 *   bun run deploy:prod
 *   bun run plan:dev       # preview the changes (needs Cloudflare credentials)
 *
 * Two stages, `dev` and `prod`, each with its own Worker (the SvelteKit app, built by
 * adapter-cloudflare exactly as `bun run preview` runs it), D1 database and two R2 buckets.
 * Binding names (DB, RAW, RENDERS), vars, compatibility date and flags come from wrangler.jsonc,
 * which stays the config for local tooling (`vite dev`, `wrangler d1 --local`, `wrangler types`,
 * scripts/ingest.ts), so local and deployed Workers can't drift apart. Alchemy adds ASSETS.
 *
 * Physical names include the stage: Worker `factorio-prints-<stage>`, D1
 * `factorio-prints-<stage>-db-<generation>`, R2 `factorio-prints-<stage>-raw` and `-renders`.
 * The prefix is fixed and also names the Alchemy stack, so renaming the site or the repo never
 * replaces resources.
 */
import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import { Config, Effect, Option } from 'effect';
import { unstable_readConfig } from 'wrangler';
import { DATABASES, PREFIX, STAGES, type Stage } from './infra/databases';

/** The parts of wrangler.jsonc used here (wrangler's own config type isn't exported). */
interface LocalConfig {
	compatibility_date: string;
	compatibility_flags: string[];
	vars: Record<string, unknown>;
	d1_databases: { binding: string }[];
	r2_buckets: { binding: string }[];
}
const local: LocalConfig = unstable_readConfig({ config: 'wrangler.jsonc' }, { hideWarnings: true });

// Fail fast if wrangler.jsonc gains a binding this file doesn't provision.
const expected = { d1: ['DB'], r2: ['RAW', 'RENDERS'] };
const actual = { d1: local.d1_databases.map((d) => d.binding), r2: local.r2_buckets.map((b) => b.binding) };
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
	throw new Error(`wrangler.jsonc bindings ${JSON.stringify(actual)} differ from alchemy.run.ts ${JSON.stringify(expected)}`);
}
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
			return yield* Effect.die(new Error(`Unknown stage "${stage}": pass --stage dev or --stage prod`));
		}
		const name = `${PREFIX}-${stage}`;
		const { bound, importTarget } = DATABASES[stage as Stage];

		// Data-bearing resources are retained: deleting them from this file, `alchemy destroy` or a
		// generation swap only makes Alchemy forget them. Delete them by hand when sure. Dev D1 is
		// the exception, so `destroy:dev` cleans up and swapped-out dev generations go away.
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
		const renders = yield* Cloudflare.R2.Bucket('Renders', { name: `${name}-renders` }).pipe(Alchemy.RemovalPolicy.retain());

		// Optional custom domain, e.g. SITE_DOMAIN_PROD=example.com, SITE_DOMAIN_DEV=dev.example.com
		// (in .env or the shell). The zone must already be in the account. Unset leaves domains
		// unmanaged; it never detaches one.
		const domain = Option.getOrUndefined(yield* Config.option(Config.String(`SITE_DOMAIN_${stage.toUpperCase()}`)));

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
				...vars,
				// Empty (in wrangler.jsonc) means /admin is a 404 on this stage.
				ACCESS_TEAM_DOMAIN: admin ? (teamDomain ?? '') : '',
				ACCESS_AUD: admin ? admin.aud : ''
			}
		});

		return {
			url: worker.url,
			database: db.databaseName,
			importTarget: importTarget === undefined ? undefined : `${name}-db-${importTarget}`,
			buckets: [raw.bucketName, renders.bucketName],
			admin: admin === undefined ? undefined : `https://${domain}/admin/pipeline`
		};
	})
);
