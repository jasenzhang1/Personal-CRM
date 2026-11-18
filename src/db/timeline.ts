/**
 * Who you connected with, day by day, from the dates the exports carry:
 * Instagram (when you followed someone / they followed you), LinkedIn ("Connected on"),
 * Facebook (became friends) and people you added by hand.
 */
import type { SQLiteDatabase } from './types';

export type TimelineKind = 'ig_followed' | 'ig_follower' | 'linkedin' | 'facebook' | 'instagram' | 'manual';

export const KIND_TEXT: Record<TimelineKind, { verb: string; source: string; mine: boolean }> = {
  ig_followed: { verb: 'You followed them on Instagram', source: 'instagram', mine: true },
  ig_follower: { verb: 'Followed you on Instagram', source: 'instagram', mine: false },
  instagram: { verb: 'Connected on Instagram', source: 'instagram', mine: true },
  linkedin: { verb: 'Connected on LinkedIn', source: 'linkedin', mine: true },
  facebook: { verb: 'Became friends on Facebook', source: 'facebook', mine: true },
  manual: { verb: 'You added them here', source: 'phone', mine: true },
};

export interface TimelineEvent {
  day: string; // YYYY-MM-DD
  kind: TimelineKind;
  person_id: number;
  name: string;
  photo: string | null;
  status: string;
}

export async function timelineEvents(db: SQLiteDatabase): Promise<TimelineEvent[]> {
  const cols = 'p.id AS person_id, p.name, p.photo, p.status';
  const igSynced = ((await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM ig_accounts'))?.n ?? 0) > 0;
  const rows = await db.getAllAsync<TimelineEvent>(
    `SELECT a.i_follow_since AS day, 'ig_followed' AS kind, ${cols}
       FROM ig_accounts a JOIN sources s ON s.source = 'instagram' AND s.external_id = a.username JOIN people p ON p.id = s.person_id
      WHERE a.i_follow_since IS NOT NULL
     UNION ALL
     SELECT a.follows_me_since, 'ig_follower', ${cols}
       FROM ig_accounts a JOIN sources s ON s.source = 'instagram' AND s.external_id = a.username JOIN people p ON p.id = s.person_id
      WHERE a.follows_me_since IS NOT NULL
     UNION ALL
     SELECT s.connected_on, s.source, ${cols}
       FROM sources s JOIN people p ON p.id = s.person_id
      WHERE s.connected_on IS NOT NULL AND s.external_id NOT LIKE 'chat:%'
        AND (s.source IN ('linkedin', 'facebook') OR (s.source = 'instagram' AND ?))
     UNION ALL
     SELECT substr(p.created_at, 1, 10), 'manual', ${cols}
       FROM people p WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.person_id = p.id)`,
    igSynced ? 0 : 1, // before follower lists are synced, fall back to the one Instagram date we have
  );
  return rows.filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.day ?? '')).sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name));
}
