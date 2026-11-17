import type { SQLiteDatabase } from './types';
import type { Circle, Stage } from '@/lib/constants';

export type PersonStatus = 'new' | 'backlog' | 'reviewed' | 'archived';

export interface Person {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  photo: string | null;
  company: string | null;
  title: string | null;
  how_met: string | null;
  met_on: string | null;
  notes: string | null;
  closeness: number;
  follow_up: string;
  last_contacted: string | null;
  status: PersonStatus;
  stage: Stage | null;
  priority: string | null;
  deal_value: number | null;
  next_step: string | null;
  next_step_on: string | null;
  /** What you set; null means "guess from where they came from" (see inferCircle). */
  circle: Circle | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  id: number;
  person_id: number;
  source: string;
  external_id: string;
  handle: string | null;
  first_seen: string;
}

export interface StageEvent {
  id: number;
  person_id: number;
  from_stage: string | null;
  to_stage: string | null;
  note: string | null;
  at: string;
}

/** Columns the edit screen is allowed to write. */
export const EDITABLE_FIELDS = [
  'name', 'phone', 'email', 'birthday', 'company', 'title', 'how_met', 'met_on', 'notes',
  'closeness', 'follow_up', 'last_contacted', 'status', 'priority', 'deal_value', 'next_step', 'next_step_on',
  'circle', 'photo',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
export type PersonPatch = Partial<Pick<Person, EditableField>>;

const now = () => new Date().toISOString();

/** A person plus the extras the People table shows. */
export interface PersonListRow extends Person {
  sources: string[];
  tags: string[];
  /** Their Instagram username without "@", when we know it. */
  ig_handle: string | null;
}

const TAG_SEP = '\u001f';

export async function listPeople(
  db: SQLiteDatabase,
  opts: { status?: PersonStatus[]; search?: string; tag?: string } = {},
): Promise<PersonListRow[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status?.length) {
    where.push(`p.status IN (${opts.status.map(() => '?').join(',')})`);
    params.push(...opts.status);
  }
  if (opts.search?.trim()) {
    const q = `%${opts.search.trim()}%`;
    where.push(`(p.name LIKE ? OR p.company LIKE ? OR p.how_met LIKE ? OR p.notes LIKE ?
                 OR EXISTS (SELECT 1 FROM person_tags t WHERE t.person_id = p.id AND t.tag LIKE ?)
                 OR EXISTS (SELECT 1 FROM sources s WHERE s.person_id = p.id AND s.handle LIKE ?))`);
    params.push(q, q, q, q, q, q);
  }
  if (opts.tag) {
    where.push('EXISTS (SELECT 1 FROM person_tags t WHERE t.person_id = p.id AND t.tag = ?)');
    params.push(opts.tag);
  }
  const rows = await db.getAllAsync<Person & { source_list: string | null; tag_list: string | null; ig_raw: string | null }>(
    `SELECT p.*,
            (SELECT GROUP_CONCAT(DISTINCT s.source) FROM sources s WHERE s.person_id = p.id) AS source_list,
            (SELECT GROUP_CONCAT(t.tag, '${TAG_SEP}') FROM person_tags t WHERE t.person_id = p.id) AS tag_list,
            (SELECT s.handle FROM sources s WHERE s.person_id = p.id AND s.source = 'instagram' AND s.handle IS NOT NULL ORDER BY s.first_seen LIMIT 1) AS ig_raw
     FROM people p ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.name COLLATE NOCASE`,
    params,
  );
  return rows.map(({ source_list, tag_list, ig_raw, ...p }) => ({
    ...p,
    ig_handle: ig_raw ? ig_raw.replace(/^@/, '') : null,
    sources: source_list ? source_list.split(',') : [],
    tags: tag_list ? tag_list.split(TAG_SEP).sort((a, b) => a.localeCompare(b)) : [],
  }));
}

export async function getTags(db: SQLiteDatabase, personId: number) {
  const rows = await db.getAllAsync<{ tag: string }>('SELECT tag FROM person_tags WHERE person_id = ? ORDER BY tag COLLATE NOCASE', personId);
  return rows.map((r) => r.tag);
}

/** Replace a person's tags. Tags are case-insensitive: "UCLA" and "ucla" are the same tag. */
export async function setTags(db: SQLiteDatabase, personId: number, tags: string[]) {
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM person_tags WHERE person_id = ?', personId);
    for (const tag of tags) {
      const t = tag.trim();
      if (t) await db.runAsync('INSERT OR IGNORE INTO person_tags (person_id, tag) VALUES (?, ?)', personId, t);
    }
  });
}

/** Every tag in use, most-used first, spelled the way it was first typed. */
export function allTags(db: SQLiteDatabase) {
  return db.getAllAsync<{ tag: string; n: number }>(
    'SELECT MIN(tag) AS tag, COUNT(*) AS n FROM person_tags GROUP BY tag ORDER BY n DESC, tag COLLATE NOCASE',
  );
}

export function listPipeline(db: SQLiteDatabase) {
  return db.getAllAsync<Person>(
    `SELECT * FROM people WHERE stage IS NOT NULL AND status != 'archived'
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
              next_step_on IS NULL, next_step_on, name COLLATE NOCASE`,
  );
}

export function getPerson(db: SQLiteDatabase, id: number) {
  return db.getFirstAsync<Person>('SELECT * FROM people WHERE id = ?', id);
}

export function getSources(db: SQLiteDatabase, personId: number) {
  return db.getAllAsync<SourceRow>('SELECT * FROM sources WHERE person_id = ? ORDER BY first_seen', personId);
}

export function getStageEvents(db: SQLiteDatabase, personId: number) {
  return db.getAllAsync<StageEvent>('SELECT * FROM stage_events WHERE person_id = ? ORDER BY at DESC, id DESC', personId);
}

export async function countByStatus(db: SQLiteDatabase, status: PersonStatus) {
  const r = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM people WHERE status = ?', status);
  return r?.n ?? 0;
}

export async function createPerson(db: SQLiteDatabase, patch: PersonPatch & { name: string }) {
  const t = now();
  const fields = EDITABLE_FIELDS.filter((f) => patch[f] !== undefined);
  const r = await db.runAsync(
    `INSERT INTO people (${[...fields, 'created_at', 'updated_at'].join(', ')})
     VALUES (${[...fields, 'c', 'u'].map(() => '?').join(', ')})`,
    [...fields.map((f) => patch[f] as string | number | null), t, t],
  );
  return r.lastInsertRowId;
}

export async function updatePerson(db: SQLiteDatabase, id: number, patch: PersonPatch) {
  const fields = EDITABLE_FIELDS.filter((f) => patch[f] !== undefined);
  if (!fields.length) return;
  await db.runAsync(
    `UPDATE people SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...fields.map((f) => patch[f] as string | number | null), now(), id],
  );
}

export async function deletePerson(db: SQLiteDatabase, id: number) {
  await db.runAsync('DELETE FROM people WHERE id = ?', id);
}

/** Move a person through the pipeline and log the change to their lifecycle timeline. */
export async function setStage(db: SQLiteDatabase, id: number, to: Stage | null, note?: string) {
  const p = await getPerson(db, id);
  if (!p || p.stage === to) return;
  const t = now();
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE people SET stage = ?, updated_at = ? WHERE id = ?', to, t, id);
    await db.runAsync(
      'INSERT INTO stage_events (person_id, from_stage, to_stage, note, at) VALUES (?, ?, ?, ?, ?)',
      id, p.stage, to, note ?? null, t,
    );
  });
}

export async function addStageNote(db: SQLiteDatabase, id: number, note: string) {
  const p = await getPerson(db, id);
  if (!p) return;
  await db.runAsync(
    'INSERT INTO stage_events (person_id, from_stage, to_stage, note, at) VALUES (?, ?, ?, ?, ?)',
    id, p.stage, p.stage, note, now(),
  );
}

export async function getSetting(db: SQLiteDatabase, key: string) {
  const r = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return r?.value ?? null;
}

export async function setSetting(db: SQLiteDatabase, key: string, value: string | null) {
  if (value === null) await db.runAsync('DELETE FROM settings WHERE key = ?', key);
  else await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, value);
}

/** "@jane.doe", "jane.doe" or "https://www.instagram.com/jane.doe/?hl=en" → "jane.doe" (or null if it isn't a valid username). */
export function parseInstagramUsername(input: string): string | null {
  const s = input.trim().replace(/^(https?:\/\/)?(www\.|m\.)?instagram\.com\/(_u\/)?/i, '').replace(/[/?#].*$/, '').replace(/^@/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(s) ? s : null;
}

/**
 * Link an Instagram account to someone by hand (for people who only came from your chats, which
 * don't include usernames). Future Instagram imports of that account then match this person.
 */
export async function addInstagramAccount(
  db: SQLiteDatabase,
  personId: number,
  input: string,
): Promise<{ ok: true; username: string } | { ok: false; error: string; otherId?: number }> {
  const username = parseInstagramUsername(input);
  if (!username) return { ok: false, error: 'That doesn’t look like an Instagram username. Paste their profile link or type it like jane.doe' };
  const existing = await db.getFirstAsync<{ person_id: number; name: string }>(
    "SELECT s.person_id, p.name FROM sources s JOIN people p ON p.id = s.person_id WHERE s.source = 'instagram' AND s.external_id = ?",
    username.toLowerCase(),
  );
  if (existing && existing.person_id !== personId)
    return { ok: false, error: `@${username} is already on ${existing.name}. If that's the same person, use “Merge with someone…” below.`, otherId: existing.person_id };
  if (!existing)
    await db.runAsync(
      "INSERT INTO sources (person_id, source, external_id, handle, first_seen) VALUES (?, 'instagram', ?, ?, ?)",
      personId, username.toLowerCase(), '@' + username, new Date().toISOString(),
    );
  return { ok: true, username };
}
