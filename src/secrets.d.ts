// Worker secrets, which `wrangler types` can't see (alchemy.run.ts binds them; docs/deploy.md).
declare namespace Cloudflare {
	interface Env {
		/** Turnstile's secret for TURNSTILE_SITE_KEY (src/lib/server/turnstile.ts). */
		TURNSTILE_SECRET_KEY?: string;
		/** API token with Zone → Cache Purge on CACHE_ZONE_ID (src/lib/server/takedown.ts). */
		CACHE_PURGE_TOKEN?: string;
		/** Sign-in apps' secrets (src/lib/server/auth/providers.ts; docs/deploy.md, "Sign-in"). Unset: that provider is off. */
		DISCORD_CLIENT_SECRET?: string;
		GITHUB_CLIENT_SECRET?: string;
		GOOGLE_CLIENT_SECRET?: string;
	}
}
