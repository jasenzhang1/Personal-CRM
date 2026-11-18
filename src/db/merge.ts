import type { SQLiteDatabase } from './types';
import type { Person } from './people';
import { findDuplicates, nameKey, nameOptions, pairKey, type DupPair, type DupPerson } from '@/lib/duplicates';
import { looksStandard } from '@/lib/names';

/** Possible duplicate pairs, minus the ones you said aren't the same person. */
export async function listDuplicates(db: SQLiteDatabase): Promise<DupPair[]> {
  const people = await db.getAllAsync<Omit<DupPerson, 'sources'>>("SELECT id, name, nickname, email, phone FROM people WHERE status != 'archived'");
  const sources = await db.getAllAsync<DupPerson['sources'][number] & { person_id: number }>(
    'SELECT person_id, source, external_id, handle, display_name FROM sources',
  );
  const byPerson = new Map<number, DupPerson['sources']>();
  for (const s of sources) byPerson.set(s.person_id, [...(byPerson.get(s.person_id) ?? []), s]);
  const dismissed = new Set((await db.getAllAsync<{ a: number; b: number }>('SELECT a, b FROM not_duplicates')).map((r) => pairKey(r.a, r.b)));
  const renamed = await db.getAllAsync<{ a: number; b: number }>(
    `SELECT o.person_id AS a, n.person_id AS b FROM account_renames r
       JOIN sources o ON o.source = r.source AND o.external_id = r.old_id
       JOIN sources n ON n.source = r.source AND n.external_id = r.new_id
     WHERE r.applied = 0`,
  );
  return findDuplicates(people.map((p) => ({ ...p, sources: byPerson.get(p.id) ?? [] })), dismissed, renamed);
}

/** "Not the same person": stop suggesting this pair. */
export async function dismissDuplicate(db: SQLiteDatabase, a: number, b: number) {
  await db.runAsync('INSERT OR IGNORE INTO not_duplicates (a, b) VALUES (?, ?)', Math.min(a, b), Math.max(a, b));
}

/** How much is known about someone: used to suggest which of two records to keep. */
export async function richness(db: SQLiteDatabase, p: Person) {
  const fields = [p.phone, p.email, p.birthday, p.photo, p.company, p.how_met, p.notes, p.met_on, p.stage, p.circle].filter(Boolean).length;
  const extra = await db.getFirstAsync<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM rankings WHERE person_id = ?) * 5 + (SELECT COUNT(*) FROM person_tags WHERE person_id = ?) * 2
          + (SELECT COUNT(*) FROM sources WHERE person_id = ?) AS n`,
    p.id, p.id, p.id,
  );
  return fields * 2 + (p.status === 'reviewed' ? 3 : 0) + (looksStandard(p.name) ? 2 : 0) + (extra?.n ?? 0);
}

const FILL: (keyof Person)[] = ['nickname', 'phone', 'email', 'birthday', 'photo', 'company', 'title', 'city', 'how_met', 'met_on', 'circle', 'stage', 'priority', 'deal_value', 'next_step', 'next_step_on'];
const STATUS_RANK: Record<string, number> = { archived: 0, new: 1, backlog: 2, reviewed: 3 };

/**
 * Merge `dropId` into `keepId` and delete `dropId`. Nothing is lost: blank fields are filled from
 * the other record, notes are combined, and imports, chats, call logs, tags, pipeline history and
 * rankings all move over. Future imports of either account land on the kept person.
 */
export async function mergePeople(db: SQLiteDatabase, keepId: number, dropId: number, name?: string) {
  if (keepId === dropId) return;
  const keep = await db.getFirstAsync<Person>('SELECT * FROM people WHERE id = ?', keepId);
  const drop = await db.getFirstAsync<Person>('SELECT * FROM people WHERE id = ?', dropId);
  if (!keep || !drop) throw new Error('One of those people no longer exists.');

  const patch: Record<string, unknown> = {};
  for (const k of FILL) if ((keep[k] === null || keep[k] === '') && drop[k] !== null && drop[k] !== '') patch[k] = drop[k];
  const kn = keep.notes?.trim();
  const dn = drop.notes?.trim();
  if (kn && dn && kn !== dn) patch.notes = `${kn}\n\n${dn}`;
  else if (!kn && dn) patch.notes = dn;
  if (drop.closeness > keep.closeness) patch.closeness = drop.closeness;
  if (drop.last_contacted && (!keep.last_contacted || drop.last_contacted > keep.last_contacted)) patch.last_contacted = drop.last_contacted;
  if (keep.follow_up === 'none' && drop.follow_up !== 'none') patch.follow_up = drop.follow_up;
  if ((STATUS_RANK[drop.status] ?? 0) > (STATUS_RANK[keep.status] ?? 0)) patch.status = drop.status;
  if (drop.created_at < keep.created_at) patch.created_at = drop.created_at; // you've known them since the earlier one
  if (name?.trim()) {
    patch.name = name.trim();
    patch.name_ok = 1;
  }
  // Two real names for one person ("Wei Zhang" + "David Zhang"): keep the one not chosen as their nickname.
  const finalName = (patch.name as string | undefined) ?? keep.name;
  const other = [keep.name, drop.name].find((n) => nameKey(n) !== nameKey(finalName) && looksStandard(n));
  if (other && !keep.nickname && !drop.nickname && looksStandard(finalName)) {
    const [o, f] = [nameKey(other).split(' '), nameKey(finalName).split(' ')];
    const sameLast = o.length >= 2 && o[o.length - 1] === f[f.length - 1];
    // Same first name ("Kevin Lee" / "Kevin Li") is a spelling difference, not a second name.
    if (o[0] !== f[0]) patch.nickname = sameLast ? other.trim().split(/\s+/).slice(0, -1).join(' ') : other.trim();
  }
  patch.updated_at = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    const keys = Object.keys(patch);
    await db.runAsync(`UPDATE people SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k] as never), keepId);
    await db.runAsync('UPDATE sources SET person_id = ? WHERE person_id = ?', keepId, dropId);
    await db.runAsync('UPDATE stage_events SET person_id = ? WHERE person_id = ?', keepId, dropId);
    await db.runAsync('INSERT OR IGNORE INTO person_tags (person_id, tag) SELECT ?, tag FROM person_tags WHERE person_id = ?', keepId, dropId);
    await db.runAsync(
      `INSERT INTO interactions (person_id, day, source, messages, calls, call_seconds)
       SELECT ?, day, source, messages, calls, call_seconds FROM interactions WHERE person_id = ?
       ON CONFLICT (person_id, day, source) DO UPDATE SET
         messages = messages + excluded.messages, calls = calls + excluded.calls, call_seconds = call_seconds + excluded.call_seconds`,
      keepId, dropId,
    );
    // Keep whichever ranking you set more recently.
    const rk = await db.getFirstAsync<{ ranked_at: string }>('SELECT ranked_at FROM rankings WHERE person_id = ?', keepId);
    const rd = await db.getFirstAsync<{ ranked_at: string }>('SELECT ranked_at FROM rankings WHERE person_id = ?', dropId);
    if (rd && (!rk || rd.ranked_at > rk.ranked_at)) {
      await db.runAsync('DELETE FROM rankings WHERE person_id = ?', keepId);
      await db.runAsync('UPDATE rankings SET person_id = ? WHERE person_id = ?', keepId, dropId);
    }
    for (const t of ['person_tags', 'interactions', 'rankings']) await db.runAsync(`DELETE FROM ${t} WHERE person_id = ?`, dropId);
    await db.runAsync('DELETE FROM not_duplicates WHERE a = ? OR b = ?', dropId, dropId);
    await db.runAsync('DELETE FROM people WHERE id = ?', dropId);
  });
}

/**
 * Merge every "likely the same" pair in one go. Someone who matches more than one person
 * (a contact "Kevin Lee" vs both @kevinlee1 and @kevin.lee.2) is left for you to decide.
 * Each merge keeps the record with more on it and the proper "First Last" name.
 */
export async function mergeAllLikely(db: SQLiteDatabase): Promise<{ merged: number; skipped: number }> {
  const pairs = (await listDuplicates(db)).filter((p) => p.strong);
  const seen = new Map<number, number>();
  for (const p of pairs) for (const id of [p.a, p.b]) seen.set(id, (seen.get(id) ?? 0) + 1);
  const clear = pairs.filter((p) => seen.get(p.a) === 1 && seen.get(p.b) === 1);
  let merged = 0;
  for (const p of clear) {
    const a = await db.getFirstAsync<Person>('SELECT * FROM people WHERE id = ?', p.a);
    const b = await db.getFirstAsync<Person>('SELECT * FROM people WHERE id = ?', p.b);
    if (!a || !b) continue;
    const [keep, drop] = (await richness(db, b)) > (await richness(db, a)) ? [b, a] : [a, b];
    const name = nameOptions(keep, drop)[0];
    await mergePeople(db, keep.id, drop.id, looksStandard(name) && name !== keep.name ? name : undefined);
    merged++;
  }
  return { merged, skipped: pairs.length - clear.length };
}
