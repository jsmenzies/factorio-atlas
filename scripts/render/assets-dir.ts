import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Without FPSR_ASSETS_DIR: the last (by name) asset bundle in ~/fpsr-assets/<game version>/, if any. */
export const defaultAssets = () => {
	const dir = join(homedir(), 'fpsr-assets');
	try {
		return (
			readdirSync(dir)
				.filter((d) => existsSync(join(dir, d, 'manifest.json')))
				.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
				.map((d) => join(dir, d))
				.at(-1) ?? null
		);
	} catch {
		return null;
	}
};
