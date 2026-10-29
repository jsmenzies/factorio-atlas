/**
 * Just enough of the D1 API over bun:sqlite to run PrintRepositoryD1 and the search SQL
 * outside a Worker, in tests.
 * `meta.rows_written` is SQLite's change count, close to what D1 bills; `meta.changes` the same count.
 */
import type { Database, SQLQueryBindings } from 'bun:sqlite';

type Args = SQLQueryBindings[];

class Statement {
	constructor(
		private readonly db: Database,
		readonly sql: string,
		readonly args: Args = []
	) {}
	bind(...args: unknown[]) {
		return new Statement(this.db, this.sql, args as Args);
	}
	async first<T>(): Promise<T | null> {
		return (this.db.query(this.sql).get(...this.args) as T | null) ?? null;
	}
	async all<T>() {
		return { results: this.db.query(this.sql).all(...this.args) as T[], success: true, meta: { rows_written: 0, changes: 0 } };
	}
	async run() {
		const r = this.db.query(this.sql).run(...this.args);
		return { results: [], success: true, meta: { rows_written: r.changes, changes: r.changes } };
	}
	/** Rows for SELECTs, the change count for writes. */
	exec() {
		const q = this.db.query(this.sql);
		if (/^\s*(SELECT|WITH)\b/i.test(this.sql))
			return { results: q.all(...this.args), success: true, meta: { rows_written: 0, changes: 0 } };
		const r = q.run(...this.args);
		return { results: [], success: true, meta: { rows_written: r.changes, changes: r.changes } };
	}
}

export const d1FromSqlite = (db: Database): D1Database =>
	({
		prepare: (sql: string) => new Statement(db, sql),
		batch: async (stmts: Statement[]) => db.transaction(() => stmts.map((s) => s.exec()))(),
		exec: async (sql: string) => {
			db.run(sql);
			return { count: 0, duration: 0 };
		}
	}) as unknown as D1Database;
