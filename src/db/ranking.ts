import type { SQLiteDatabase } from './types';
import { isoDate } from '@/lib/dates';
import { activityScore, assignRanks, scoreInfo, type ActivityDay, type RankedRow, type ScoreInfo } from '@/lib/ranking';

const now = () => new Date().toISOString();

export function listRanking(db: SQLiteDatabase) {
  return db.getAllAsync<RankedRow>('SELECT * FROM rankings');
}

/** Save where the game placed someone: their new score, and their activity right now. */
export async function setPlacement(db: SQLiteDatabase, personId: number, score: number, activity: number) {
  await db.runAsync(
    `INSERT INTO rankings (person_id, base, act_at, ranked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (person_id) DO UPDATE SET base = excluded.base, act_at = excluded.act_at, ranked_at = excluded.ranked_at`,
    personId, score, activity, now(),
  );
}

/** Forget a placement: they go back to an estimate from activity. */
export async function removeRanking(db: SQLiteDatabase, personId: number) {
  await db.runAsync('DELETE FROM rankings WHERE person_id = ?', personId);
}

/* ---------------- activity ---------------- */

/** Daily totals per person (all sources combined) for the last two years. */
export async function activityByPerson(db: SQLiteDatabase): Promise<Map<number, ActivityDay[]>> {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 2);
  const rows = await db.getAllAsync<ActivityDay & { person_id: number }>(
    `SELECT person_id, day, SUM(messages) AS messages, SUM(calls) AS calls, SUM(call_seconds) AS call_seconds
     FROM interactions WHERE day >= ? GROUP BY person_id, day`,
    isoDate(since),
  );
  const out = new Map<number, ActivityDay[]>();
  for (const r of rows) {
    const list = out.get(r.person_id) ?? [];
    list.push(r);
    out.set(r.person_id, list);
  }
  return out;
}

export interface ActivitySummary {
  messages90: number;
  calls90: number;
  callSeconds90: number;
  messagesAll: number;
  callsAll: number;
  callSecondsAll: number;
  lastDay: string | null;
  days: ActivityDay[];
}

export async function activitySummary(db: SQLiteDatabase, personId: number): Promise<ActivitySummary> {
  const days = await db.getAllAsync<ActivityDay>(
    `SELECT day, SUM(messages) AS messages, SUM(calls) AS calls, SUM(call_seconds) AS call_seconds
     FROM interactions WHERE person_id = ? GROUP BY day ORDER BY day`,
    personId,
  );
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const c = isoDate(cutoff);
  const s: ActivitySummary = { messages90: 0, calls90: 0, callSeconds90: 0, messagesAll: 0, callsAll: 0, callSecondsAll: 0, lastDay: null, days };
  for (const d of days) {
    s.messagesAll += d.messages;
    s.callsAll += d.calls;
    s.callSecondsAll += d.call_seconds;
    if (d.day >= c) {
      s.messages90 += d.messages;
      s.calls90 += d.calls;
      s.callSeconds90 += d.call_seconds;
    }
    s.lastDay = d.day;
  }
  return s;
}

/** Log a call or hangout by hand ("we got dinner, 2 hours"). Adds to anything already logged that day. */
export async function logInteraction(db: SQLiteDatabase, personId: number, day: string, minutes: number) {
  await db.runAsync(
    `INSERT INTO interactions (person_id, day, source, messages, calls, call_seconds) VALUES (?, ?, 'manual', 0, 1, ?)
     ON CONFLICT (person_id, day, source) DO UPDATE SET calls = calls + 1, call_seconds = call_seconds + excluded.call_seconds`,
    personId, day, Math.round(minutes * 60),
  );
  await db.runAsync(
    'UPDATE people SET last_contacted = ?, updated_at = ? WHERE id = ? AND (last_contacted IS NULL OR last_contacted < ?)',
    day, now(), personId, day,
  );
}

/**
 * Replace everything one export says about these people. Re-importing a newer export of the
 * same app therefore never double-counts; hand-logged hangouts ('manual') are never touched.
 */
export async function replaceInteractions(db: SQLiteDatabase, source: string, perPerson: Map<number, ActivityDay[]>) {
  await db.withTransactionAsync(async () => {
    for (const [personId, days] of perPerson) {
      await db.runAsync('DELETE FROM interactions WHERE person_id = ? AND source = ?', personId, source);
      for (const d of days) {
        await db.runAsync(
          'INSERT INTO interactions (person_id, day, source, messages, calls, call_seconds) VALUES (?, ?, ?, ?, ?, ?)',
          personId, d.day, source, d.messages, d.calls, d.call_seconds,
        );
      }
      const last = days.reduce<string | null>((m, d) => (m === null || d.day > m ? d.day : m), null);
      if (last)
        await db.runAsync(
          'UPDATE people SET last_contacted = ? WHERE id = ? AND (last_contacted IS NULL OR last_contacted < ?)',
          last, personId, last,
        );
    }
  });
}

/**
 * Score for everyone in `people`, with `rank` set among all of them. Pass everyone (not a filtered
 * list) when the rank number matters.
 */
export async function loadScores(
  db: SQLiteDatabase,
  people: { id: number; closeness: number; last_contacted: string | null }[],
  today = new Date(),
): Promise<Map<number, ScoreInfo>> {
  const rows = new Map((await listRanking(db)).map((r) => [r.person_id, r]));
  const activity = await activityByPerson(db);
  const out = new Map<number, ScoreInfo>();
  for (const p of people) {
    const act = activityScore(activity.get(p.id) ?? [], p.last_contacted, today);
    const row = rows.get(p.id);
    // Placements carried over from before activity was tracked start drifting from today.
    if (row && row.act_at === null) {
      row.act_at = act;
      await db.runAsync('UPDATE rankings SET act_at = ? WHERE person_id = ?', act, p.id);
    }
    out.set(p.id, scoreInfo({ row, hearts: p.closeness, activity: act }));
  }
  assignRanks(out);
  return out;
}
