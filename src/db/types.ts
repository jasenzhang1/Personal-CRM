export type SqlParam = string | number | null;

/**
 * The small async SQLite surface the app uses. Implemented by sql.js in the browser
 * (src/db/browser.ts) and by node:sqlite in tests.
 * Params may be passed variadically or as a single array.
 */
export interface SQLiteDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (SqlParam | SqlParam[])[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getFirstAsync<T>(sql: string, ...params: (SqlParam | SqlParam[])[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: (SqlParam | SqlParam[])[]): Promise<T[]>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
}
