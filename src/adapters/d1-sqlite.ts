/**
 * D1Database-compatible adapter backed by better-sqlite3.
 *
 * Implements the subset of the Cloudflare D1 API used by this project:
 *   - prepare(sql).bind(...values).run()     → INSERT / UPDATE / DELETE
 *   - prepare(sql).bind(...values).all<T>()  → SELECT multiple rows
 *   - prepare(sql).bind(...values).first<T>()→ SELECT single row
 *   - batch([stmt, ...])                     → atomic multi-statement transaction
 *
 * better-sqlite3 natively supports SQLite's ?NNN positional parameter
 * syntax (e.g. ?1, ?2), which is the same syntax used by D1, so no
 * query rewriting is needed.
 */

import Database from "better-sqlite3";

// ── Statement ─────────────────────────────────────────────────

export class SQLiteD1Statement {
  private readonly _db: Database.Database;
  private readonly _query: string;
  private _values: unknown[] = [];

  constructor(db: Database.Database, query: string) {
    this._db = db;
    this._query = query;
  }

  bind(...values: unknown[]): this {
    this._values = values;
    return this;
  }

  /** Run a mutation (INSERT / UPDATE / DELETE). */
  async run(): Promise<{ meta: { changes: number } }> {
    const result = this._db.prepare(this._query).run(...this._values);
    return { meta: { changes: result.changes } };
  }

  /** Run a SELECT returning all matching rows. */
  async all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: boolean;
  }> {
    const results = this._db.prepare(this._query).all(...this._values) as T[];
    return { results, success: true };
  }

  /** Run a SELECT returning the first row, or null. */
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = this._db
      .prepare(this._query)
      .get(...this._values) as T | undefined;
    return result ?? null;
  }

  /**
   * Internal: execute synchronously inside a batch transaction.
   * Not part of the public D1 API.
   */
  _runSync(): { changes: number } {
    return this._db.prepare(this._query).run(...this._values);
  }
}

// ── Database ──────────────────────────────────────────────────

export class SQLiteD1Database {
  private readonly _db: Database.Database;

  constructor(dbPath: string) {
    this._db = new Database(dbPath);
    this._db.pragma("journal_mode = WAL");
    this._db.pragma("foreign_keys = ON");
  }

  prepare(query: string): SQLiteD1Statement {
    return new SQLiteD1Statement(this._db, query);
  }

  /**
   * Execute raw SQL strings (for schema initialisation).
   * Not part of the D1 API, but used during server startup.
   */
  exec(sql: string): void {
    this._db.exec(sql);
  }

  /**
   * Run multiple statements in a single atomic transaction —
   * equivalent to Cloudflare D1's `db.batch([])`.
   */
  async batch<T = Record<string, unknown>>(
    statements: SQLiteD1Statement[],
  ): Promise<Array<{ results: T[]; success: boolean; meta: { changes: number } }>> {
    return this._db.transaction(() =>
      statements.map((stmt) => {
        const result = stmt._runSync();
        return {
          results: [] as T[],
          success: true,
          meta: { changes: result.changes },
        };
      }),
    )();
  }

  close(): void {
    this._db.close();
  }
}
