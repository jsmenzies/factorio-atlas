const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** `length` base62 characters from crypto randomness (bytes ≥ 248 are skipped, so every character is equally likely). */
export const randomBase62 = (length: number) => {
	let out = '';
	while (out.length < length) {
		for (const b of crypto.getRandomValues(new Uint8Array(16))) {
			if (b < 248 && out.length < length) out += BASE62[b % 62];
		}
	}
	return out;
};
