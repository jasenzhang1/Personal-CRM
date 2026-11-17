/**
 * Closeness: one 0–10 number per person, no fixed buckets.
 *
 * - Everyone starts with an **estimate** from how much you talk (messages, calls, hangouts),
 *   so the list is already roughly in order on day one.
 * - The comparison game ("who are you closer to?") **places** one person at a time with a
 *   binary search against everyone else. Their new score sits between the two people they
 *   landed between, so the list order and the scores always agree.
 * - After that, a placed score keeps **drifting** with activity: talk a lot more than when you
 *   placed them and it rises; go quiet and it falls. The game re-asks whoever moved the most.
 * - "Not close anymore" drops someone straight to 0.
 */
import { daysBetween, parseIsoDate } from './dates';

/** How strongly a placed score follows later changes in activity (0.5 = half as fast). */
export const DRIFT = 0.5;

export interface RankedRow {
  person_id: number;
  /** Score you gave them when you last placed them. */
  base: number;
  /** Their activity score at that moment; later activity is measured against it. */
  act_at: number | null;
  ranked_at: string;
}

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

/** Starting guess before you've compared them: activity, or your hearts if those say more. */
export function estimateScore(activity: number, hearts: number): number {
  return round1(Math.max(activity, hearts * 1.8));
}

/* ---------------- scores ---------------- */

export interface ScoreInfo {
  score: number; // 0–10, what every list sorts by
  placed: boolean; // you've placed them with the game (otherwise it's an estimate)
  activity: number; // 0–10
  /** How far activity has moved a placed score since you placed them (+ closer, − quieter). */
  drift: number;
  rankedAt?: string;
  rank?: number; // position among everyone with a score above 0
  drifting: boolean;
  growing: boolean;
}

export function scoreInfo(opts: { row?: RankedRow; hearts: number; activity: number }): ScoreInfo {
  const { row, activity } = opts;
  if (!row) {
    return { score: estimateScore(activity, opts.hearts), placed: false, activity, drift: 0, drifting: false, growing: false };
  }
  const drift = round1(DRIFT * (activity - (row.act_at ?? activity)));
  const score = round2(clamp(row.base + drift));
  return {
    score,
    placed: true,
    activity,
    drift,
    rankedAt: row.ranked_at,
    drifting: row.base >= 5 && drift <= -1.5,
    growing: drift >= 1.5,
  };
}

/** Number everyone with a score, highest first (ties share the order they came in). */
export function assignRanks(scores: Map<number, ScoreInfo>) {
  const sorted = [...scores].filter(([, s]) => s.score > 0).sort((a, b) => b[1].score - a[1].score);
  sorted.forEach(([, s], i) => (s.rank = i + 1));
  return sorted.map(([id]) => id);
}

export function describeScoreInfo(s: ScoreInfo): string {
  if (!s.placed) return s.score > 0 ? 'Estimate from how much you talk. Play Rank to confirm.' : 'No activity yet. Rank them to give a score.';
  const parts = [`You placed them at ${(s.score - s.drift).toFixed(1)}`];
  if (s.drift >= 0.1) parts.push(`+${s.drift.toFixed(1)} from talking more since`);
  if (s.drift <= -0.1) parts.push(`${s.drift.toFixed(1)} from talking less since`);
  return parts.join(' · ');
}

/* ---------------- the comparison game ---------------- */

export interface Placement {
  personId: number;
  /** Everyone else with a score, closest first. */
  others: { id: number; score: number }[];
  lo: number;
  hi: number;
  /** Set when you answered "about the same": they take that person's score. */
  tieScore?: number;
}

export const startPlacement = (personId: number, others: { id: number; score: number }[]): Placement => {
  const list = others.filter((o) => o.id !== personId);
  return { personId, others: list, lo: 0, hi: list.length };
};

/** Who to compare against next, or null when the spot is found. */
export const nextOpponent = (p: Placement): number | null => (p.lo >= p.hi ? null : p.others[Math.floor((p.lo + p.hi) / 2)].id);

export function answerPlacement(p: Placement, answer: 'new' | 'other' | 'tie'): Placement {
  const mid = Math.floor((p.lo + p.hi) / 2);
  if (answer === 'new') return { ...p, hi: mid };
  if (answer === 'other') return { ...p, lo: mid + 1 };
  return { ...p, lo: mid + 1, hi: mid + 1, tieScore: p.others[mid].score };
}

/**
 * Score for where they landed: halfway between the person above and the person below. Closer
 * than everyone means near the top of the scale (most of the way to 10); less close than
 * everyone means half of the lowest score.
 */
export function placedScore(p: Placement): number {
  if (p.tieScore !== undefined) return p.tieScore;
  const below = p.others[p.lo]?.score ?? 0;
  if (p.lo === 0) return round2(10 - (10 - below) * 0.25);
  return round2((p.others[p.lo - 1].score + below) / 2);
}

/** Rough number of questions left, for a progress hint. */
export const questionsLeft = (p: Placement) => (p.hi > p.lo ? Math.ceil(Math.log2(p.hi - p.lo + 1)) : 0);

/**
 * Who the game should ask about next. Unplaced people with high estimates come first (they
 * matter most), then placed people whose score has drifted, then whoever you placed longest ago.
 */
export function nextToPlace(scores: Map<number, ScoreInfo>, skip: Set<number>, today = new Date()): number | null {
  let best: number | null = null;
  let bestP = -Infinity;
  for (const [id, s] of scores) {
    if (skip.has(id) || s.score <= 0) continue;
    let p: number;
    if (!s.placed) p = 2 + s.score;
    else {
      const d = s.rankedAt ? parseIsoDate(s.rankedAt.slice(0, 10)) : null;
      const age = d ? Math.max(0, daysBetween(d, today)) : 365;
      p = Math.abs(s.drift) * 3 + Math.min(age / 30, 3) - 1;
    }
    if (p > bestP) {
      bestP = p;
      best = id;
    }
  }
  return best;
}

/** Stored scores keep two decimals so many people can fit between two others. */
const round2 = (n: number) => Math.round(n * 100) / 100;

export function round1(n: number) {
  return Math.round(n * 10) / 10;
}

const clamp = (n: number) => Math.max(0, Math.min(10, n));
