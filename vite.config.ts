import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { renderControl } from './scripts/render/dev-plugin.ts';
import { syncControl } from './scripts/sync/dev-plugin.ts';

export default defineConfig({
	server: {
		// Render output and the local D1/R2 hold hundreds of thousands of files that runs rewrite
		// constantly; watching them costs the dev server one inotify watch per file, gigabytes of
		// memory and a busy CPU. No module is ever imported from them.
		watch: { ignored: ['**/data/renders/**', '**/data/thumbs/**', '**/.wrangler/**'] }
	},
	plugins: [
		// Dev only: starts render runs for /admin/render (scripts/render/dev-plugin.ts).
		renderControl(),
		// Dev only: the admin Overview's update and check buttons (scripts/sync/dev-plugin.ts).
		syncControl(),
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			adapter: adapter(),
			// Content Security Policy on every page (the other security headers: src/lib/server/security-headers.ts).
			// Nonce mode: a new nonce per response on SvelteKit's start-up script, and Cloudflare reads it from this
			// header and adds it to the scripts it injects at the edge (Bot Fight Mode's JavaScript detections, Web
			// Analytics). A cached page keeps its matching header and nonce. Inline styles are allowed for the icons'
			// style attributes; images may come from any https host, as authors' descriptions embed them
			// (lib/server/markdown.ts allows https only).
			csp: {
				mode: 'nonce',
				directives: {
					'default-src': ['self'],
					// Web Analytics' automatic setup loads beacon.min.js from here and reports to /cdn-cgi/rum (connect-src 'self').
					// Turnstile (src/lib/server/turnstile.ts) on the removal-request form: its script, and its widget's frame.
					'script-src': ['self', 'https://static.cloudflareinsights.com', 'https://challenges.cloudflare.com'],
					'frame-src': ['https://challenges.cloudflare.com'],
					// Svelte's server output puts onload/onerror="this.__e=event" on <img> tags with handlers (Icon's
					// fallback), so events before hydration are replayed. Only that exact string may run; any other
					// inline handler stays blocked. If Svelte ever changes the string, icons that fail before
					// hydration lose their blank fallback and the browser logs a violation.
					'script-src-attr': ['unsafe-hashes', 'sha256-7dQwUgLau1NFCCGjfn9FsYptB6ZtWxJin6VohGIu20I='],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:', 'https:'],
					'connect-src': ['self'],
					'font-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none']
				}
			}
		})
	]
});
