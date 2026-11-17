import type { SQLiteDatabase } from './types';
import { looksStandard, suggestName, type NameSuggestion } from '@/lib/names';

export interface NameRow {
  id: number;
  name: string;
  photo: string | null;
  /** Their username(s), e.g. "@john.smith_99". */
  handles: string[];
  suggestion: NameSuggestion | null;
}

const now = () => new Date().toISOString();

/** Everyone whose name isn't "First Last" yet and that you haven't told us to keep. */
export async function nameReviewList(db: SQLiteDatabase): Promise<NameRow[]> {
  const people = await db.getAllAsync<{ id: number; name: string; photo: string | null }>(
    "SELECT id, name, photo FROM people WHERE name_ok = 0 AND status != 'archived'",
  );
  const todo = people.filter((p) => !looksStandard(p.name));
  if (!todo.length) return [];
  const sources = await db.getAllAsync<{ person_id: number; external_id: string; handle: string | null; display_name: string | null }>(
    'SELECT person_id, external_id, handle, display_name FROM sources',
  );
  const byPerson = new Map<number, typeof sources>();
  for (const s of sources) byPerson.set(s.person_id, [...(byPerson.get(s.person_id) ?? []), s]);
  return todo.map((p) => {
    const rows = byPerson.get(p.id) ?? [];
    const handles = rows.map((r) => r.handle).filter((h): h is string => !!h && !/^https?:/.test(h));
    const chatNames = rows.map((r) => r.display_name).filter((n): n is string => !!n);
    return { ...p, handles, suggestion: suggestName({ name: p.name, usernames: handles, chatNames }) };
  });
}

/** Set a name you chose. Name cleanup won't touch it again. */
export async function renamePerson(db: SQLiteDatabase, id: number, name: string) {
  await db.runAsync('UPDATE people SET name = ?, name_ok = 1, updated_at = ? WHERE id = ?', name.trim(), now(), id);
}

/** "Keep as is": stop suggesting a new name for this person. */
export async function keepName(db: SQLiteDatabase, id: number) {
  await db.runAsync('UPDATE people SET name_ok = 1 WHERE id = ?', id);
}

/** Apply suggestions (only the sure ones unless `all`). Returns how many changed and how many still need a look. */
export async function applyNameSuggestions(db: SQLiteDatabase, opts: { all?: boolean; ids?: number[] } = {}) {
  const list = await nameReviewList(db);
  const pick = list.filter((r) => r.suggestion && (opts.all || r.suggestion.confidence === 'high') && (!opts.ids || opts.ids.includes(r.id)));
  const t = now();
  await db.withTransactionAsync(async () => {
    for (const r of pick) await db.runAsync('UPDATE people SET name = ?, updated_at = ? WHERE id = ?', r.suggestion!.name, t, r.id);
  });
  return { fixed: pick.length, left: list.length - pick.length };
}

export const AUTO_NAMES_KEY = 'autoCleanNames';
