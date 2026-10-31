/** SHA-256 of text (UTF-8) or bytes, as 64 lowercase hex characters (Web Crypto, so the Worker and Bun alike). */
export const sha256Hex = async (data: string | Uint8Array | ArrayBuffer): Promise<string> => {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
	return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
};
