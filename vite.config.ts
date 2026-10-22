import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { renderControl } from './scripts/render/dev-plugin.ts';

export default defineConfig({
	server: {
		// Render output and the local D1/R2 hold hundreds of thousands of files that runs rewrite
		// constantly; watching them costs the dev server one inotify watch per file, gigabytes of
		// memory and a busy CPU. No module is ever imported from them.
		watch: { ignored: ['**/data/renders/**', '**/.wrangler/**'] }
	},
	plugins: [
		// Dev only: starts render runs for /admin/render (scripts/render/dev-plugin.ts).
		renderControl(),
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			adapter: adapter()
		})
	]
});
