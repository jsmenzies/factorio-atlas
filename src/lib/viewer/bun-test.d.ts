// Minimal types for `bun test`, so svelte-check passes without adding @types/bun.
declare module 'bun:test' {
	interface Matchers {
		toBe(expected: unknown): void;
		toEqual(expected: unknown): void;
		toMatchObject(expected: object): void;
		toBeNull(): void;
		toBeUndefined(): void;
		toContain(expected: unknown): void;
		toBeGreaterThan(expected: number): void;
		toBeLessThan(expected: number): void;
		toBeCloseTo(expected: number, digits?: number): void;
		toThrow(expected?: unknown): void;
		not: Matchers;
		rejects: { toThrow(expected?: unknown): Promise<void> };
	}
	export function test(name: string, fn: () => void | Promise<void>): void;
	export function describe(name: string, fn: () => void): void;
	export function beforeEach(fn: () => void | Promise<void>): void;
	export function afterEach(fn: () => void | Promise<void>): void;
	export function expect(actual: unknown): Matchers;
	export const mock: { module(specifier: string, factory: () => unknown): void };
}
