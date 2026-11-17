/**
 * Instagram followers / following over time.
 *
 * Instagram exports say who follows you and who you follow *right now*, but never who unfollowed
 * you. So every import saves a snapshot, and the next (newer) export is compared with it:
 * anyone who followed you before and is missing now unfollowed you sometime between the two
 * exports. The first export you import is the starting point.
 */
import type { SQLiteDatabase } from '@/db/types';
import { getSetting, setSetting } from '@/db/people';
import { isoDate } from '@/lib/dates';

export type FollowList = 'followers' | 'following';

/** connections/followers_and_following/followers_1.json → 'followers', following.json → 'following' */
export function followListKind(path: string): FollowList | null {
  if (/(^|\/)threads\//i.test(path)) return null; // Threads app lists, not Instagram
  const base = path.split('/').pop()!.toLowerCase();
  if (/^followers(_\d+)?\.json$/.test(base)) return 'followers';
  if (base === 'following.json') return 'following';
  return null;
}
export const isUnfollowedByMeEntry = (path: string) => /(^|\/)recently_unfollowed_profiles\.json$/i.test(path) && !/(^|\/)threads\//i.test(path);

export interface FollowEntry {
  username: string; // lowercase
  display: string; // as Instagram writes it
  at: string | null; // YYYY-MM-DD when the follow (or unfollow) happened
}

type Item = {
  title?: string;
  timestamp?: number;
  string_list_data?: { href?: string; value?: string; timestamp?: number }[];
  label_values?: { label?: string; value?: string }[];
};

/** Works for followers_N.json (array), following.json ({relationships_following: [...]}) and label lists. */
export function parseFollowList(text: string): FollowEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const items: Item[] = [];
  if (Array.isArray(json)) items.push(...(json as Item[]));
  else if (json && typeof json === 'object') for (const v of Object.values(json)) if (Array.isArray(v)) items.push(...(v as Item[]));
  const out = new Map<string, FollowEntry>();
  for (const it of items) {
    const d = it.string_list_data?.[0];
    const label = (l: string) => it.label_values?.find((x) => x.label?.toLowerCase() === l)?.value;
    const fromHref = (d?.href ?? label('url') ?? '').replace(/\/+$/, '').split('/').pop();
    const display = (d?.value || label('username') || it.title || fromHref || '').trim().replace(/^@/, '');
    if (!display) continue;
    const ts = d?.timestamp ?? it.timestamp;
    out.set(display.toLowerCase(), { username: display.toLowerCase(), display, at: ts ? isoDate(new Date(ts * 1000)) : null });
  }
  return [...out.values()];
}

/** "instagram-jane-2026-11-16-abc.zip › connections/…" → "2026-11-16" (when you downloaded it). */
export function exportDateOf(entryName: string): string | null {
  const zip = entryName.split(' › ')[0];
  return /(\d{4}-\d{2}-\d{2})/.exec(zip)?.[1] ?? null;
}

export interface FollowSyncResult {
  list: FollowList;
  count: number;
  /** True on the very first import: nothing to compare with yet. */
  baseline: boolean;
  /** This export is older than one you already imported, so it was only used for names. */
  older: boolean;
  previous: string | null;
  gained: number;
  lost: number;
}

/** Save the current followers or following list and record who appeared or disappeared since last time. */
export async function syncFollowList(db: SQLiteDatabase, list: FollowList, entries: FollowEntry[], exportDate: string): Promise<FollowSyncResult> {
  const key = `ig_${list}_export`;
  const previous = await getSetting(db, key);
  const res: FollowSyncResult = { list, count: entries.length, baseline: !previous, older: false, previous, gained: 0, lost: 0 };
  if (previous && exportDate < previous) return { ...res, older: true };

  const flag = list === 'followers' ? 'follows_me' : 'i_follow';
  const since = list === 'followers' ? 'follows_me_since' : 'i_follow_since';
  const [gainKind, lossKind] = list === 'followers' ? ['followed_me', 'unfollowed_me'] : ['i_followed', 'i_unfollowed'];
  const now = new Date().toISOString();
  const current = new Set(entries.map((e) => e.username));
  const before = new Set((await db.getAllAsync<{ username: string }>(`SELECT username FROM ig_accounts WHERE ${flag} = 1`)).map((r) => r.username));

  await db.withTransactionAsync(async () => {
    for (const e of entries) {
      await db.runAsync(
        `INSERT INTO ig_accounts (username, display, ${flag}, ${since}, updated_at) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (username) DO UPDATE SET display = excluded.display, ${flag} = 1,
           ${since} = COALESCE(excluded.${since}, ig_accounts.${since}), updated_at = excluded.updated_at`,
        e.username, e.display, e.at, now,
      );
      if (previous && !before.has(e.username)) {
        res.gained++;
        await db.runAsync('INSERT OR IGNORE INTO ig_events (username, kind, at, after) VALUES (?, ?, ?, ?)', e.username, gainKind, e.at ?? exportDate, previous);
      }
    }
    for (const u of before) {
      if (current.has(u)) continue;
      await db.runAsync(`UPDATE ig_accounts SET ${flag} = 0, updated_at = ? WHERE username = ?`, now, u);
      if (previous) {
        res.lost++;
        // We only know it happened between the last export and this one.
        await db.runAsync('INSERT OR IGNORE INTO ig_events (username, kind, at, after) VALUES (?, ?, ?, ?)', u, lossKind, exportDate, previous);
      }
    }
  });
  await setSetting(db, key, exportDate);
  return res;
}

/** Instagram's own list of people *you* unfollowed recently, with dates. */
export async function recordUnfollowedByMe(db: SQLiteDatabase, entries: FollowEntry[]) {
  let n = 0;
  for (const e of entries) {
    const r = await db.runAsync('INSERT OR IGNORE INTO ig_events (username, kind, at, after) VALUES (?, ?, ?, NULL)', e.username, 'i_unfollowed', e.at);
    n += r.changes;
    await db.runAsync(
      'INSERT INTO ig_accounts (username, display, updated_at) VALUES (?, ?, ?) ON CONFLICT (username) DO NOTHING',
      e.username, e.display, new Date().toISOString(),
    );
  }
  return n;
}

export function describeFollowSync(r: FollowSyncResult): string {
  const what = r.list === 'followers' ? 'followers' : 'accounts you follow';
  if (r.older) return `Instagram ${what}: this export is older than the one from ${r.previous}, so changes weren't compared.`;
  if (r.baseline) return `Instagram ${what}: saved ${r.count.toLocaleString()} as a starting point. Import a newer export later to see who unfollowed.`;
  if (r.list === 'followers')
    return `Instagram followers since ${r.previous}: ${r.gained.toLocaleString()} new, ${r.lost.toLocaleString()} unfollowed you.`;
  return `Accounts you follow since ${r.previous}: ${r.gained.toLocaleString()} followed, ${r.lost.toLocaleString()} unfollowed.`;
}
