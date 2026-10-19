// Minimal types for `bun test`, so svelte-check passes without adding @types/bun.
declare module 'bun:test' {
	interface Matchers {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toBeGreaterThan(expected: number): void;
		toBeCloseTo(expected: number, digits?: number): void;
		not: Matchers;
	}
	export function test(name: string, fn: () => void | Promise<void>): void;
	export function describe(name: string, fn: () => void): void;
	export function expect(actual: unknown): Matchers;
}
