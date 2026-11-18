/**
 * Every way you got connected with someone, day by day, from the dates your data carries:
 * Instagram follows (both directions), LinkedIn connections, Facebook and Discord friends,
 * your first message and first call on each app, calls and hangouts you logged, contacts saved
 * in your phone's address book (when the export dates them), and people you added here.
 */
import type { SQLiteDatabase } from './types';

export type TimelineKind =
  | 'ig_followed'
  | 'ig_follower'
  | 'instagram'
  | 'linkedin'
  | 'facebook'
  | 'discord'
  | 'first_message'
  | 'first_call'
  | 'hangout'
  | 'contact_saved'
  | 'manual';

/** Filter groups shown as chips. */
export type TimelineGroup = 'followed' | 'follower' | 'connected' | 'messaged' | 'calls' | 'contact' | 'added';
export const GROUPS: { key: TimelineGroup; label: string }[] = [
  { key: 'followed', label: 'You followed' },
  { key: 'follower', label: 'Followed you' },
  { key: 'connected', label: 'Connected / friends' },
  { key: 'messaged', label: 'First message' },
  { key: 'calls', label: 'Calls & hangouts' },
  { key: 'contact', label: 'Saved contact' },
  { key: 'added', label: 'Added here' },
];

const SOURCE_NAME: Record<string, string> = { instagram: 'Instagram', facebook: 'Messenger', discord: 'Discord', manual: '' };

export const KIND_INFO: Record<TimelineKind, { group: TimelineGroup; verb: (e: TimelineEvent) => string }> = {
  ig_followed: { group: 'followed', verb: () => 'You followed them on Instagram' },
  ig_follower: { group: 'follower', verb: () => 'Followed you on Instagram' },
  instagram: { group: 'followed', verb: () => 'Connected on Instagram' },
  linkedin: { group: 'connected', verb: () => 'Connected on LinkedIn' },
  facebook: { group: 'connected', verb: () => 'Became friends on Facebook' },
  discord: { group: 'connected', verb: () => 'Became friends on Discord' },
  first_message: { group: 'messaged', verb: (e) => `First message on ${SOURCE_NAME[e.source] ?? e.source}` },
  first_call: { group: 'calls', verb: (e) => `First call${SOURCE_NAME[e.source] ? ` on ${SOURCE_NAME[e.source]}` : ''}` },
  hangout: { group: 'calls', verb: (e) => `You logged a call or hangout${e.minutes ? ` (${e.minutes >= 60 ? `${Math.round(e.minutes / 6) / 10} h` : `${e.minutes} min`})` : ''}` },
  contact_saved: { group: 'contact', verb: () => 'Saved in your phone contacts' },
  manual: { group: 'added', verb: () => 'You added them here' },
};

/** Which platform icon to show. */
export const iconFor = (e: TimelineEvent) =>
  e.kind === 'ig_followed' || e.kind === 'ig_follower' || e.kind === 'instagram'
    ? 'instagram'
    : e.kind === 'contact_saved' || e.kind === 'manual' || e.kind === 'hangout'
      ? 'phone'
      : e.kind === 'first_message' || e.kind === 'first_call'
        ? e.source === 'manual'
          ? 'phone'
          : e.source
        : e.kind;

export interface TimelineEvent {
  day: string; // YYYY-MM-DD
  kind: TimelineKind;
  source: string; // for messages/calls: instagram | facebook | discord
  minutes: number | null; // logged hangouts
  person_id: number;
  name: string;
  photo: string | null;
  status: string;
}

export async function timelineEvents(db: SQLiteDatabase): Promise<TimelineEvent[]> {
  const cols = 'p.id AS person_id, p.name, p.photo, p.status';
  const igSynced = ((await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM ig_accounts'))?.n ?? 0) > 0;
  const rows = await db.getAllAsync<TimelineEvent>(
    `-- Instagram follows, both directions
     SELECT a.i_follow_since AS day, 'ig_followed' AS kind, 'instagram' AS source, NULL AS minutes, ${cols}
       FROM ig_accounts a JOIN sources s ON s.source = 'instagram' AND s.external_id = a.username JOIN people p ON p.id = s.person_id
      WHERE a.i_follow_since IS NOT NULL
     UNION ALL
     SELECT a.follows_me_since, 'ig_follower', 'instagram', NULL, ${cols}
       FROM ig_accounts a JOIN sources s ON s.source = 'instagram' AND s.external_id = a.username JOIN people p ON p.id = s.person_id
      WHERE a.follows_me_since IS NOT NULL
     UNION ALL
     -- LinkedIn / Facebook / Discord friends; older imports only kept one date per person ("when you met")
     SELECT COALESCE(s.connected_on, CASE WHEN s.source IN ('linkedin', 'facebook') THEN p.met_on END), s.source, s.source, NULL, ${cols}
       FROM sources s JOIN people p ON p.id = s.person_id
      WHERE s.external_id NOT LIKE 'chat:%' AND (s.source IN ('linkedin', 'facebook', 'discord') OR (s.source = 'instagram' AND ?))
        AND COALESCE(s.connected_on, CASE WHEN s.source IN ('linkedin', 'facebook') THEN p.met_on END) IS NOT NULL
     UNION ALL
     -- Address books that record when each contact was saved (Facebook's uploaded contacts)
     SELECT MIN(s.connected_on), 'contact_saved', 'phone', NULL, ${cols}
       FROM sources s JOIN people p ON p.id = s.person_id
      WHERE s.source = 'phone' AND s.connected_on IS NOT NULL GROUP BY p.id
     UNION ALL
     -- First message and first call on each app
     SELECT MIN(i.day), 'first_message', i.source, NULL, ${cols}
       FROM interactions i JOIN people p ON p.id = i.person_id
      WHERE i.messages > 0 AND i.source != 'manual' GROUP BY p.id, i.source
     UNION ALL
     SELECT MIN(i.day), 'first_call', i.source, NULL, ${cols}
       FROM interactions i JOIN people p ON p.id = i.person_id
      WHERE i.calls > 0 AND i.source != 'manual' GROUP BY p.id, i.source
     UNION ALL
     -- Every call or hangout you logged by hand
     SELECT i.day, 'hangout', 'manual', ROUND(i.call_seconds / 60.0), ${cols}
       FROM interactions i JOIN people p ON p.id = i.person_id
      WHERE i.source = 'manual'
     UNION ALL
     -- People you added here yourself
     SELECT substr(p.created_at, 1, 10), 'manual', 'phone', NULL, ${cols}
       FROM people p WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.person_id = p.id)`,
    igSynced ? 0 : 1, // before follower lists are synced, fall back to the one Instagram date we have
  );
  return rows
    .filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.day ?? ''))
    .map((r) => ({ ...r, day: r.day.slice(0, 10) }))
    .sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name));
}

/** The first day you were connected with each person in any way (logged hangouts don't count as "new"). */
export function firstConnected(events: TimelineEvent[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const e of events) {
    if (e.kind === 'hangout') continue;
    const cur = out.get(e.person_id);
    if (!cur || e.day < cur) out.set(e.person_id, e.day);
  }
  return out;
}
