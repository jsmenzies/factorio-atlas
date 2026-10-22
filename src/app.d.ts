// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces. Cloudflare bindings come from
// `import { env } from 'cloudflare:workers'`: adapter-cloudflare 8 passes no `platform`.
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
