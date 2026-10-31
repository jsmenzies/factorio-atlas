/**
 * `f` over `xs`, `size` at a time (each run of calls settles before the next starts), the results in order: so
 * thousands of files aren't all open at once.
 */
export async function mapInChunks<T, R>(xs: readonly T[], size: number, f: (x: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < xs.length; i += size) out.push(...(await Promise.all(xs.slice(i, i + size).map((x) => f(x)))));
	return out;
}
