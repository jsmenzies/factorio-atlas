// Worker secrets, which `wrangler types` can't see (alchemy.run.ts binds them; docs/deploy.md).
declare namespace Cloudflare {
	interface Env {
		/** Turnstile's secret for TURNSTILE_SITE_KEY (src/lib/server/turnstile.ts). */
		TURNSTILE_SECRET_KEY?: string;
		/** API token with Zone → Cache Purge on CACHE_ZONE_ID (src/lib/server/takedown.ts). */
		CACHE_PURGE_TOKEN?: string;
	}
}
