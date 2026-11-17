/**
 * Real names from an Instagram export.
 *
 * Instagram's followers and following lists only have usernames, but a few smaller lists in the
 * same export (Close Friends, follow requests, recently unfollowed, removed suggestions) include
 * each account's display name next to its username. We save that name on the matching Instagram
 * account so "Clean up names" can use it (as a sure fix) and "Merge duplicates" can match on it.
 */
import type { SQLiteDatabase } from '@/db/types';
import { fixMojibake } from './parsers';

const NAME_FILES = /^(close_friends|pending_follow_requests|recent_follow_requests|recently_unfollowed_profiles|removed_suggestions)\.json$/i;

export const isInstagramNameEntry = (path: string) => NAME_FILES.test(path.split('/').pop() ?? '') && !/(^|\/)threads\//i.test(path);

type LabelItem = { label_values?: { label?: string; value?: string; href?: string }[] };

export function parseInstagramNames(text: string): { username: string; name: string }[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const items: LabelItem[] = [];
  if (Array.isArray(json)) items.push(...(json as LabelItem[]));
  else if (json && typeof json === 'object') for (const v of Object.values(json)) if (Array.isArray(v)) items.push(...(v as LabelItem[]));
  const out: { username: string; name: string }[] = [];
  for (const item of items) {
    const get = (label: string) => item.label_values?.find((l) => l.label?.toLowerCase() === label)?.value?.trim();
    const username = get('username')?.replace(/^@/, '');
    const name = get('name');
    if (username && name && name.toLowerCase() !== username.toLowerCase()) out.push({ username: username.toLowerCase(), name: fixMojibake(name) });
  }
  return out;
}


/** Attach names to Instagram accounts already in your people. Returns how many accounts got a name. */
export async function applyInstagramNames(db: SQLiteDatabase, list: { username: string; name: string }[]): Promise<number> {
  let n = 0;
  await db.withTransactionAsync(async () => {
    for (const { username, name } of list) {
      const r = await db.runAsync(
        `UPDATE sources SET display_name = ? WHERE source = 'instagram' AND external_id = ? AND (display_name IS NULL OR display_name != ?)`,
        name, username, name,
      );
      n += r.changes;
    }
  });
  return n;
}
