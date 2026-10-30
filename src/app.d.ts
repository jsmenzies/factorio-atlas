// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces. Cloudflare bindings come from
// `import { env } from 'cloudflare:workers'`: adapter-cloudflare 8 passes no `platform`.
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/**
			 * The signed-in account, or null. Reads the session (one D1 read) the first time a route asks;
			 * throws on the cached routes (lib/server/auth/locals.ts).
			 */
			account: import('#lib/server/auth/locals.js').AccountReader;
		}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
