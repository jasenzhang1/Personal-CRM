/**
 * Spotting people who changed their username or name between two exports.
 *
 * Exports identify Instagram accounts by username, Facebook friends by name and LinkedIn
 * connections by profile URL, so a rename looks like one account leaving and a new one arriving.
 * The date you connected doesn't change with a rename, so a vanished account and a new one with
 * the same connection date are very likely the same person.
 */
import type { SQLiteDatabase } from '@/db/types';
import { nameKey } from '@/lib/duplicates';

export interface Account {
  id: string;
  /** When you connected (YYYY-MM-DD). Accounts without one are never matched. */
  on: string | null;
  name?: string;
}
export interface RenameMatch {
  oldId: string;
  newId: string;
  /** The only account gone and the only one new on that date. */
  unique: boolean;
}

/** Share a real word, like a first name ("Jane Smith" → "Jane Doe"). */
export const sharesWord = (a: string, b: string) => {
  const wa = new Set(nameKey(a).split(' ').filter((w) => w.length >= 2));
  return nameKey(b).split(' ').some((w) => wa.has(w));
};

/**
 * Pair accounts that disappeared with accounts that appeared on the same connection date.
 * One of each on a date is a unique match. Two of each on a date gives every pairing as
 * non-unique, and with `needWord`, only pairs whose names share a word. More than that is too
 * crowded to guess.
 */
export function matchRenames(gone: Account[], arrived: Account[], needWord = false): RenameMatch[] {
  const group = (list: Account[]) => {
    const m = new Map<string, Account[]>();
    for (const a of list) if (a.on) m.set(a.on, [...(m.get(a.on) ?? []), a]);
    return m;
  };
  const g = group(gone);
  const n = group(arrived);
  const out: RenameMatch[] = [];
  for (const [day, olds] of g) {
    const news = n.get(day);
    if (!news) continue;
    if (olds.length === 1 && news.length === 1) {
      out.push({ oldId: olds[0].id, newId: news[0].id, unique: true });
      continue;
    }
    if (olds.length > 2 || news.length > 2) continue;
    for (const o of olds)
      for (const w of news) if (!needWord || (o.name && w.name && sharesWord(o.name, w.name))) out.push({ oldId: o.id, newId: w.id, unique: false });
  }
  return out;
}

/** Remember a possible rename, shown on the Duplicates page once both accounts belong to people. */
export async function suggestRename(db: SQLiteDatabase, source: string, oldId: string, newId: string, at: string) {
  await db.runAsync('INSERT OR IGNORE INTO account_renames (source, old_id, new_id, at, applied) VALUES (?, ?, ?, ?, 0)', source, oldId, newId, at);
}

/**
 * An Instagram account went from `from` to `to`: move its follow history and its person over, and
 * update their name if it was still just the old username. If the new username already belongs to
 * someone else, the two are only suggested as duplicates.
 */
export async function renameInstagram(db: SQLiteDatabase, from: string, to: string, display: string, at: string) {
  type Row = { display: string | null; follows_me: number; i_follow: number; follows_me_since: string | null; i_follow_since: string | null };
  const a = await db.getFirstAsync<Row>('SELECT * FROM ig_accounts WHERE username = ?', from);
  const b = await db.getFirstAsync<Row>('SELECT * FROM ig_accounts WHERE username = ?', to);
  await db.runAsync('DELETE FROM ig_accounts WHERE username IN (?, ?)', from, to);
  await db.runAsync(
    `INSERT INTO ig_accounts (username, display, follows_me, i_follow, follows_me_since, i_follow_since, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    to, display,
    Math.max(a?.follows_me ?? 0, b?.follows_me ?? 0), Math.max(a?.i_follow ?? 0, b?.i_follow ?? 0),
    a?.follows_me_since ?? b?.follows_me_since ?? null, a?.i_follow_since ?? b?.i_follow_since ?? null,
    new Date().toISOString(),
  );
  await db.runAsync('UPDATE OR IGNORE ig_events SET username = ? WHERE username = ?', to, from);
  await db.runAsync('DELETE FROM ig_events WHERE username = ?', from);

  const old = await db.getFirstAsync<{ id: number; person_id: number }>("SELECT id, person_id FROM sources WHERE source = 'instagram' AND external_id = ?", from);
  const taken = await db.getFirstAsync<{ id: number; person_id: number }>("SELECT id, person_id FROM sources WHERE source = 'instagram' AND external_id = ?", to);
  if (old && taken && old.person_id !== taken.person_id) {
    await suggestRename(db, 'instagram', from, to, at);
    return;
  }
  if (old && taken) await db.runAsync('DELETE FROM sources WHERE id = ?', old.id);
  else if (old) {
    await db.runAsync('UPDATE sources SET external_id = ?, handle = ? WHERE id = ?', to, `@${display}`, old.id);
    // Their name was just the old username and you never confirmed it: show the new one.
    await db.runAsync(
      'UPDATE people SET name = ?, updated_at = ? WHERE id = ? AND name_ok = 0 AND lower(name) IN (?, ?)',
      display, new Date().toISOString(), old.person_id, from, `@${from}`,
    );
  }
  await db.runAsync('INSERT OR REPLACE INTO account_renames (source, old_id, new_id, at, applied) VALUES (?, ?, ?, ?, 1)', 'instagram', from, to, at);
}
