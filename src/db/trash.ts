import type { SQLiteDatabase, SqlParam } from './types';

/**
 * Recycle bin. Deleting someone saves a copy of them and everything attached to them here, then
 * removes them for real, so the rest of the app never has to skip "deleted" people. Restoring
 * puts the rows back under the same id (ids are never reused). Copies older than 30 days are
 * dropped.
 */

export const TRASH_DAYS = 30;

/** Tables with one row per person (person_id). */
const PERSON_TABLES = ['sources', 'stage_events', 'person_tags', 'interactions', 'rankings'] as const;
/** Tables linking two people (a, b). */
const PAIR_TABLES = ['not_duplicates', 'comparisons'] as const;

type Row = Record<string, SqlParam>;
type Snapshot = Record<string, Row[]>;

export interface TrashItem {
  person_id: number;
  name: string;
  photo: string | null;
  deleted_at: string;
  /** Whole days left before it's gone for good (0 = today). */
  daysLeft: number;
}

const cutoff = (today = new Date()) => new Date(today.getTime() - TRASH_DAYS * 86_400_000).toISOString();

/** Copy these people into the bin. Call inside a transaction, right before deleting them. */
export async function copyToTrash(db: SQLiteDatabase, ids: number[], now = new Date()) {
  await db.runAsync('DELETE FROM trash WHERE deleted_at < ?', cutoff(now));
  for (const id of ids) {
    const person = await db.getFirstAsync<Row>('SELECT * FROM people WHERE id = ?', id);
    if (!person) continue;
    const data: Snapshot = { people: [person] };
    for (const t of PERSON_TABLES) data[t] = await db.getAllAsync<Row>(`SELECT * FROM ${t} WHERE person_id = ?`, id);
    for (const t of PAIR_TABLES) data[t] = await db.getAllAsync<Row>(`SELECT * FROM ${t} WHERE a = ? OR b = ?`, id, id);
    await db.runAsync(
      'INSERT OR REPLACE INTO trash (person_id, name, photo, deleted_at, data) VALUES (?, ?, ?, ?, ?)',
      id, String(person.name ?? ''), (person.photo as string | null) ?? null, now.toISOString(), JSON.stringify(data),
    );
  }
}

/** Everyone in the bin, most recently deleted first. */
export async function listTrash(db: SQLiteDatabase, today = new Date()): Promise<TrashItem[]> {
  const rows = await db.getAllAsync<Omit<TrashItem, 'daysLeft'>>(
    'SELECT person_id, name, photo, deleted_at FROM trash WHERE deleted_at >= ? ORDER BY deleted_at DESC',
    cutoff(today),
  );
  return rows.map((r) => ({
    ...r,
    daysLeft: Math.max(0, TRASH_DAYS - Math.floor((today.getTime() - new Date(r.deleted_at).getTime()) / 86_400_000) - 1),
  }));
}

async function columns(db: SQLiteDatabase, table: string): Promise<Set<string>> {
  return new Set((await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name));
}

async function insertRow(db: SQLiteDatabase, table: string, row: Row, cols: Set<string>) {
  const keys = Object.keys(row).filter((k) => cols.has(k));
  if (!keys.length) return;
  await db.runAsync(`INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => row[k]));
}

/**
 * Put people back exactly as they were. Links to someone who's no longer there (a comparison with
 * a person you've also deleted) are skipped. Returns how many came back.
 */
export async function restoreFromTrash(db: SQLiteDatabase, ids: number[]): Promise<number> {
  let n = 0;
  await db.withTransactionAsync(async () => {
    for (const id of ids) {
      const item = await db.getFirstAsync<{ data: string }>('SELECT data FROM trash WHERE person_id = ?', id);
      if (!item) continue;
      const data = JSON.parse(item.data) as Snapshot;
      const person = data.people?.[0];
      if (person && !(await db.getFirstAsync('SELECT 1 AS x FROM people WHERE id = ?', id))) {
        await insertRow(db, 'people', person, await columns(db, 'people'));
        for (const t of PERSON_TABLES) {
          const cols = await columns(db, t);
          for (const r of data[t] ?? []) await insertRow(db, t, r, cols);
        }
        for (const t of PAIR_TABLES) {
          const cols = await columns(db, t);
          for (const r of data[t] ?? []) {
            const other = r.a === id ? r.b : r.a;
            if (await db.getFirstAsync('SELECT 1 AS x FROM people WHERE id = ?', other as number)) await insertRow(db, t, r, cols);
          }
        }
        n++;
      }
      await db.runAsync('DELETE FROM trash WHERE person_id = ?', id);
    }
  });
  return n;
}

/** Delete for good, now. No ids = empty the whole bin. */
export async function purgeTrash(db: SQLiteDatabase, ids?: number[]) {
  if (!ids) return void (await db.runAsync('DELETE FROM trash'));
  for (const id of ids) await db.runAsync('DELETE FROM trash WHERE person_id = ?', id);
}
