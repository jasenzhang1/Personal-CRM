/**
 * Beli-style friend ranking + activity.
 *
 * Feelings: you drop each person into a tier, then answer "who are you closer to?" a few times
 * (a binary search) to place them in one ordered list. Their spot in the tier sets a 0–10 score.
 *
 * Activity: messages, calls (longer = more) and hangouts you log, fading with a 60-day half-life,
 * so the score drifts down when you stop talking and climbs back when you reconnect.
 */
import { daysBetween, parseIsoDate } from './dates';

export type Tier = 'inner' | 'close' | 'casual';

export const TIERS: { key: Tier; label: string; emoji: string; hint: string; lo: number; hi: number; color: string }[] = [
  { key: 'inner', label: 'Inner circle', emoji: '💛', hint: 'Would call them in a crisis', lo: 6.8, hi: 10, color: '#00a35c' },
  { key: 'close', label: 'Good friends', emoji: '🙂', hint: 'Always glad to see them', lo: 3.4, hi: 6.7, color: '#d98a00' },
  { key: 'casual', label: 'Acquaintances', emoji: '👋', hint: 'Friendly, not close', lo: 0.1, hi: 3.3, color: '#7a7d8c' },
];
export const tierInfo = (t: string | null | undefined) => TIERS.find((x) => x.key === t);

/** Suggested starting tier from closeness hearts. */
export const tierFromHearts = (hearts: number): Tier | null => (hearts >= 5 ? 'inner' : hearts >= 3 ? 'close' : hearts >= 1 ? 'casual' : null);

export interface RankedRow {
  person_id: number;
  tier: Tier;
  pos: number;
  ranked_at: string;
}

/** Score for each ranked person: evenly spread over the tier's range, best at the top. */
export function rankScores(rows: RankedRow[]): Map<number, { feel: number; rank: number; tierRank: number; tierSize: number }> {
  const out = new Map<number, { feel: number; rank: number; tierRank: number; tierSize: number }>();
  const sorted = orderRanking(rows);
  let rank = 0;
  for (const t of TIERS) {
    const inTier = sorted.filter((r) => r.tier === t.key);
    inTier.forEach((r, i) => {
      const n = inTier.length;
      const feel = n === 1 ? t.hi : t.hi - ((t.hi - t.lo) * i) / (n - 1);
      out.set(r.person_id, { feel: round1(feel), rank: ++rank, tierRank: i + 1, tierSize: n });
    });
  }
  return out;
}

/** Tiers in order, then position within the tier. */
export function orderRanking<T extends { tier: Tier; pos: number }>(rows: T[]): T[] {
  const tierIdx = (t: Tier) => TIERS.findIndex((x) => x.key === t);
  return [...rows].sort((a, b) => tierIdx(a.tier) - tierIdx(b.tier) || a.pos - b.pos);
}

/* ---------------- placing someone: binary search ---------------- */

export interface Placement {
  personId: number;
  tier: Tier;
  /** The other people in the tier, closest first. */
  others: number[];
  lo: number;
  hi: number;
}

export const startPlacement = (personId: number, tier: Tier, tierOrder: number[]): Placement => {
  const others = tierOrder.filter((id) => id !== personId);
  return { personId, tier, others, lo: 0, hi: others.length };
};

/** Who to compare against next, or null when the spot is found (insert at `lo`). */
export const nextOpponent = (p: Placement): number | null => (p.lo >= p.hi ? null : p.others[Math.floor((p.lo + p.hi) / 2)]);

export function answerPlacement(p: Placement, answer: 'new' | 'other' | 'tie'): Placement {
  const mid = Math.floor((p.lo + p.hi) / 2);
  if (answer === 'new') return { ...p, hi: mid };
  if (answer === 'other') return { ...p, lo: mid + 1 };
  return { ...p, lo: mid + 1, hi: mid + 1 }; // too close to call: right below them
}

/** Rough number of questions left, for a progress hint. */
export const questionsLeft = (p: Placement) => (p.hi > p.lo ? Math.ceil(Math.log2(p.hi - p.lo + 1)) : 0);

/* ---------------- activity ---------------- */

export interface ActivityDay {
  day: string;
  messages: number;
  calls: number;
  call_seconds: number;
}

const HALF_LIFE_DAYS = 60;

/** Points for one day of contact. A one-hour call ≈ 17 points; a busy day of texting ≈ 10. */
export function dayPoints(d: Pick<ActivityDay, 'messages' | 'calls' | 'call_seconds'>): number {
  return Math.min(d.messages, 40) * 0.25 + d.calls * 2 + Math.min(d.call_seconds / 60, 180) * 0.25;
}

/** 0–10 activity from recent contact; older contact counts for less. */
export function activityScore(days: ActivityDay[], lastContacted: string | null, today = new Date()): number {
  let pts = 0;
  const decay = (iso: string) => {
    const d = parseIsoDate(iso);
    if (!d) return 0;
    const age = Math.max(0, daysBetween(d, today));
    return Math.pow(0.5, age / HALF_LIFE_DAYS);
  };
  for (const d of days) pts += dayPoints(d) * decay(d.day);
  if (lastContacted) pts += 4 * decay(lastContacted);
  return round1(10 * (1 - Math.exp(-pts / 30)));
}

export interface ScoreInfo {
  score: number;      // 0–10, what the People list ranks by
  feel: number | null; // from your ranking (or hearts if not ranked)
  activity: number;   // 0–10
  rank?: number;      // overall rank among ranked people
  tier?: Tier;
  ranked: boolean;
  drifting: boolean;  // close on paper, but you haven't been talking
}

/**
 * Your ranking matters most (65%); recent activity makes up the rest. People you haven't ranked
 * or given hearts to are scored from activity alone, capped at 6 — rank them to go higher.
 */
export function combineScore(feel: number | null, activity: number): number {
  return round1(feel === null ? 0.6 * activity : 0.65 * feel + 0.35 * activity);
}

export function scoreInfo(opts: {
  ranked?: { feel: number; rank: number; tier: Tier };
  hearts: number;
  activity: number;
  /** Any chats, calls or "last talked" on record — you can only drift from someone you used to talk to. */
  hasHistory?: boolean;
}): ScoreInfo {
  const feel = opts.ranked ? opts.ranked.feel : opts.hearts > 0 ? opts.hearts * 2 : null;
  return {
    score: combineScore(feel, opts.activity),
    feel,
    activity: opts.activity,
    rank: opts.ranked?.rank,
    tier: opts.ranked?.tier,
    ranked: !!opts.ranked,
    drifting: !!opts.hasHistory && feel !== null && feel >= 6 && opts.activity < 1.5,
  };
}

export function describeScoreInfo(s: ScoreInfo): string {
  const parts = [
    s.feel === null ? 'Not ranked yet' : s.ranked ? `Ranking ${s.feel.toFixed(1)}` : `Hearts ${s.feel.toFixed(1)}`,
    `Activity ${s.activity.toFixed(1)}`,
  ];
  return parts.join(' · ') + (s.drifting ? ' · Drifting: you haven’t talked much lately' : '');
}

export function round1(n: number) {
  return Math.round(n * 10) / 10;
}
