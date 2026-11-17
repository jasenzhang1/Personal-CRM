/**
 * The monthly "photo round": people whose picture is missing (or hasn't been checked in a month),
 * with the profile to copy it from. Instagram first, LinkedIn when that's all we have.
 */
import type { SQLiteDatabase } from './types';
import { getSetting, setSetting } from './people';
import { profileUrl } from '@/lib/sourceLinks';

export const PHOTO_ROUND_DAYS = 30;
const LAST_ROUND_KEY = 'photo_round_at';

export interface PhotoTodo {
  id: number;
  name: string;
  photo: string | null;
  photo_checked_at: string | null;
  /** Where to copy their picture from, best first. */
  profiles: { source: 'instagram' | 'linkedin'; url: string }[];
}

/**
 * Who to do in this round, closest first. `refresh` also includes people who have a photo that
 * hasn't been checked in a month (pictures change); otherwise only missing photos.
 */
export async function photoQueue(db: SQLiteDatabase, opts: { refresh?: boolean; order?: Map<number, number> } = {}): Promise<PhotoTodo[]> {
  const cutoff = new Date(Date.now() - PHOTO_ROUND_DAYS * 86400000).toISOString();
  const people = await db.getAllAsync<{ id: number; name: string; photo: string | null; photo_checked_at: string | null }>(
    `SELECT id, name, photo, photo_checked_at FROM people
     WHERE status != 'archived' AND (photo_checked_at IS NULL OR photo_checked_at < ?)
       ${opts.refresh ? '' : "AND (photo IS NULL OR photo = '')"}`,
    cutoff,
  );
  const sources = await db.getAllAsync<{ person_id: number; source: string; external_id: string; handle: string | null }>(
    "SELECT person_id, source, external_id, handle FROM sources WHERE source IN ('instagram', 'linkedin') ORDER BY first_seen",
  );
  const links = new Map<number, PhotoTodo['profiles']>();
  for (const s of sources) {
    const url = profileUrl(s.source, s.external_id, s.handle);
    if (!url) continue;
    const list = links.get(s.person_id) ?? [];
    if (!list.some((x) => x.source === s.source)) list.push({ source: s.source as 'instagram' | 'linkedin', url });
    links.set(s.person_id, list);
  }
  const out: PhotoTodo[] = [];
  for (const p of people) {
    const profiles = (links.get(p.id) ?? []).sort((a, b) => (a.source === 'instagram' ? -1 : 0) - (b.source === 'instagram' ? -1 : 0));
    if (profiles.length) out.push({ ...p, profiles });
  }
  const rank = opts.order;
  // Missing photos first, then closest people first.
  return out.sort((a, b) => Number(!!a.photo) - Number(!!b.photo) || (rank ? (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) : 0) || a.name.localeCompare(b.name));
}

/** Save a new picture (or just note "checked, no change / no picture") for this month. */
export async function markPhotoChecked(db: SQLiteDatabase, id: number, photo?: string) {
  const t = new Date().toISOString();
  if (photo) await db.runAsync('UPDATE people SET photo = ?, photo_checked_at = ?, updated_at = ? WHERE id = ?', photo, t, t, id);
  else await db.runAsync('UPDATE people SET photo_checked_at = ? WHERE id = ?', t, id);
  await setSetting(db, LAST_ROUND_KEY, t);
}

/** When you last did a photo round (any person), or null. */
export const lastPhotoRound = (db: SQLiteDatabase) => getSetting(db, LAST_ROUND_KEY);

/** A calendar file with a monthly "Photo round" reminder on the 1st, linking back to the site. */
export function photoRoundIcs(siteUrl: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const first = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const d = `${first.getFullYear()}${String(first.getMonth() + 1).padStart(2, '0')}01`;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Personal CRM//Photo round//EN',
    'BEGIN:VEVENT', 'UID:photo-round@personal-crm', `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1',
    'SUMMARY:📸 Photo round (Personal CRM)', `DESCRIPTION:Update profile pictures: ${siteUrl}#/photos`, `URL:${siteUrl}#/photos`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Photo round', 'TRIGGER:PT10H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}
