import initSqlJs, { type Database } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { SQLiteDatabase, SqlParam } from './types';

/**
 * SQLite running in the browser (sql.js / WebAssembly), persisted to IndexedDB.
 * Every write schedules a save; other open tabs are told to reload.
 */

const IDB_NAME = 'personal-crm';
const IDB_STORE = 'files';
const IDB_KEY = 'crm.sqlite';

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => {
        open.result.close();
        resolve(req.result as T);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const loadBytes = () => idb<Uint8Array | undefined>('readonly', (s) => s.get(IDB_KEY));
const saveBytes = (bytes: Uint8Array) => idb<void>('readwrite', (s) => s.put(bytes, IDB_KEY));

const flat = (params: (SqlParam | SqlParam[])[]): SqlParam[] =>
  (params.length === 1 && Array.isArray(params[0]) ? params[0] : (params as SqlParam[])).map((v) => (v === undefined ? null : v));

export class BrowserDb implements SQLiteDatabase {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private inTx = false;
  private dirty = false;
  private channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('personal-crm') : null;
  /** Called when another tab changed the data and we reloaded it. */
  onExternalChange: () => void = () => {};
  /** Called after each successful save to this browser. */
  onSaved: () => void = () => {};
  /** Called when the browser refused to save (storage full, private mode…). Changes stay in memory and are retried. */
  onSaveError: (e: unknown) => void = () => {};

  private constructor(private sql: Awaited<ReturnType<typeof initSqlJs>>, private db: Database) {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.channel?.addEventListener('message', async (e) => {
      if (e.data === 'saved') {
        await this.reloadFromStorage();
        this.onExternalChange();
      }
    });
    const flush = () => void this.flush();
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  }

  static async open(): Promise<BrowserDb> {
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    const bytes = await loadBytes().catch(() => undefined);
    navigator.storage?.persist?.().catch(() => {});
    return new BrowserDb(SQL, new SQL.Database(bytes));
  }

  private async reloadFromStorage() {
    const bytes = await loadBytes();
    if (!bytes) return;
    this.db.close();
    this.db = new this.sql.Database(bytes);
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  private wrote() {
    this.dirty = true;
    if (this.inTx) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 250);
  }

  async flush() {
    if (!this.dirty || this.inTx) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = false;
    const bytes = this.db.export();
    this.db.exec('PRAGMA foreign_keys = ON'); // export() resets connection pragmas
    try {
      await saveBytes(bytes);
    } catch (e) {
      console.error('Saving to this browser failed', e);
      this.dirty = true;
      if (!this.saveTimer) this.saveTimer = setTimeout(() => void this.flush(), 5000);
      this.onSaveError(e);
      return;
    }
    this.channel?.postMessage('saved');
    this.onSaved();
  }

  /** Raw database file, for backups. */
  exportFile(): Uint8Array {
    const bytes = this.db.export();
    this.db.exec('PRAGMA foreign_keys = ON');
    return bytes;
  }

  /** Replace everything with a backup file. */
  async importFile(bytes: Uint8Array) {
    const next = new this.sql.Database(bytes);
    next.exec('SELECT count(*) FROM people'); // throws if this isn't a CRM backup
    this.db.close();
    this.db = next;
    this.db.exec('PRAGMA foreign_keys = ON');
    this.dirty = true;
    await this.flush();
  }

  async execAsync(sql: string) {
    this.db.exec(sql);
    this.wrote();
  }

  async runAsync(sql: string, ...params: (SqlParam | SqlParam[])[]) {
    this.db.run(sql, flat(params));
    const changes = this.db.getRowsModified();
    const lastInsertRowId = Number(this.db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] ?? 0);
    this.wrote();
    return { changes, lastInsertRowId };
  }

  async getAllAsync<T>(sql: string, ...params: (SqlParam | SqlParam[])[]): Promise<T[]> {
    const st = this.db.prepare(sql);
    try {
      st.bind(flat(params));
      const out: T[] = [];
      while (st.step()) out.push(st.getAsObject() as T);
      return out;
    } finally {
      st.free();
    }
  }

  async getFirstAsync<T>(sql: string, ...params: (SqlParam | SqlParam[])[]): Promise<T | null> {
    return (await this.getAllAsync<T>(sql, ...params))[0] ?? null;
  }

  async withTransactionAsync(fn: () => Promise<void>) {
    this.db.exec('BEGIN');
    this.inTx = true;
    try {
      await fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
    this.wrote();
  }
}
