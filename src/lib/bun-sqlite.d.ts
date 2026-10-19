// Minimal types for the bits of bun:sqlite used offline (d1-sqlite.ts, tests), so svelte-check
// passes without adding @types/bun.
declare module 'bun:sqlite' {
	export type SQLQueryBindings = string | number | bigint | boolean | null | Uint8Array;
	export interface Query {
		get(...args: SQLQueryBindings[]): unknown;
		all(...args: SQLQueryBindings[]): unknown[];
		run(...args: SQLQueryBindings[]): { changes: number; lastInsertRowid: number | bigint };
	}
	export class Database {
		constructor(filename?: string, options?: { create?: boolean; readonly?: boolean; strict?: boolean });
		query(sql: string): Query;
		run(sql: string): void;
		transaction<T>(fn: () => T): () => T;
		close(): void;
	}
}
