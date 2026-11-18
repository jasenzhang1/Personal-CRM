/**
 * Closeness: one 0–10 number per person, no fixed buckets.
 *
 * - Everyone starts with an **estimate** from how much you talk (messages, calls, hangouts),
 *   so the list is already roughly in order on day one.
 * - The comparison game ("who are you closer to?") builds a **web** of answers between many
 *   different people. Scores are fitted to all answers at once (see fitWeb), so one answer can
 *   move people you never compared directly. Answers that go in a circle are caught (findCycle)
 *   and asked again.
 * - After that, a placed score keeps **drifting** with activity: talk a lot more than when you
 *   last compared them and it rises; go quiet and it falls.
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

/* ---------------- the comparison web ---------------- */

/**
 * One answer to "who are you closer to?", stored once per pair (a < b); answering the same pair
 * again replaces it. 'a' / 'b' = that one is closer, 'tie' = about the same.
 */
export type CompResult = 'a' | 'b' | 'tie';
export interface Comparison {
  a: number;
  b: number;
  result: CompResult;
}

export const pairKey = (x: number, y: number) => (x < y ? `${x}:${y}` : `${y}:${x}`);

/** A comparison from x's point of view: did x win, lose or tie against y? */
export function normalizeComparison(x: number, y: number, outcome: 'x' | 'y' | 'tie'): Comparison {
  const [a, b] = x < y ? [x, y] : [y, x];
  const result: CompResult = outcome === 'tie' ? 'tie' : (outcome === 'x') === (x === a) ? 'a' : 'b';
  return { a, b, result };
}

/** How strongly answers pull scores apart vs. how strongly each person stays near their starting guess. */
const FIT = { k: 1, prior: 0.08, tie: 0.3 };

/**
 * Scores from every answer at once (a Bradley–Terry fit on the 0–10 scale). Each person starts
 * at `priors` (their guess from activity, or an earlier placement); each "closer to A than B"
 * pulls A up and B down until the scores agree with your answers, each "about the same" pulls
 * the two together. One answer is enough to flip two people's order; contradictory answers
 * settle in between. Only people in `comparisons` are returned.
 */
export function fitWeb(priors: Map<number, number>, comparisons: Comparison[], iterations = 300): Map<number, number> {
  const s = new Map<number, number>();
  const prior = (id: number) => priors.get(id) ?? 0;
  for (const c of comparisons) for (const id of [c.a, c.b]) if (!s.has(id)) s.set(id, prior(id));
  // Diagonal (Newton-style) step size per person, so busy people don't overshoot.
  const curve = new Map<number, number>();
  for (const id of s.keys()) curve.set(id, 2 * FIT.prior);
  for (const c of comparisons)
    for (const id of [c.a, c.b]) curve.set(id, curve.get(id)! + (c.result === 'tie' ? 2 * FIT.tie : (FIT.k * FIT.k) / 4));
  for (let it = 0; it < iterations; it++) {
    const g = new Map<number, number>();
    for (const [id, v] of s) g.set(id, 2 * FIT.prior * (v - prior(id)));
    for (const c of comparisons) {
      const d = s.get(c.a)! - s.get(c.b)!;
      if (c.result === 'tie') {
        g.set(c.a, g.get(c.a)! + 2 * FIT.tie * d);
        g.set(c.b, g.get(c.b)! - 2 * FIT.tie * d);
        continue;
      }
      const [w, l] = c.result === 'a' ? [c.a, c.b] : [c.b, c.a];
      const push = FIT.k * (1 - 1 / (1 + Math.exp(-FIT.k * (s.get(w)! - s.get(l)!))));
      g.set(w, g.get(w)! - push);
      g.set(l, g.get(l)! + push);
    }
    for (const [id, v] of s) s.set(id, clamp(v - (0.8 * g.get(id)!) / curve.get(id)!));
  }
  for (const [id, v] of s) s.set(id, round2(v));
  return s;
}

/**
 * After you said `winner` over `loser`: do your answers now go in a circle (A over B, B over C,
 * C over A)? Returns the shortest such loop, starting [winner, loser, …], where each person is
 * closer than the next and the last is closer than the first. Null when everything lines up.
 */
export function findCycle(comparisons: Comparison[], winner: number, loser: number, maxLength = 5): number[] | null {
  const beats = new Map<number, number[]>();
  for (const c of comparisons) {
    if (c.result === 'tie') continue;
    const [w, l] = c.result === 'a' ? [c.a, c.b] : [c.b, c.a];
    beats.set(w, [...(beats.get(w) ?? []), l]);
  }
  // Breadth-first from the loser: is there a chain of "closer than" back to the winner?
  const prev = new Map<number, number>([[loser, loser]]);
  let frontier = [loser];
  for (let depth = 1; depth < maxLength && frontier.length; depth++) {
    const next: number[] = [];
    for (const x of frontier)
      for (const y of beats.get(x) ?? []) {
        if (prev.has(y)) continue;
        prev.set(y, x);
        if (y === winner) {
          const path = [winner];
          for (let at = x; at !== loser; at = prev.get(at)!) path.push(at);
          path.push(loser);
          return [winner, ...path.slice(1).reverse()];
        }
        next.push(y);
      }
    frontier = next;
  }
  return null;
}

/** Consecutive pairs of a loop, including last → first. */
export const cyclePairs = (cycle: number[]): [number, number][] => cycle.map((id, i) => [id, cycle[(i + 1) % cycle.length]]);

export interface WebCandidate {
  id: number;
  score: number;
  /** How many answers they're already in. */
  n: number;
}

/**
 * The next pair to ask about. Mixes widely: the first person is drawn at random, favouring
 * people you've compared least; the second is always someone close in score (so the answer
 * actually tells the two apart), and never someone you just saw or a pair you've
 * already answered (unless there's no one else). With `focus`, that person is always in it and
 * opponents close in on their level as `focusAsked` grows.
 */
export function pickPair(
  cands: WebCandidate[],
  opts: { asked: Set<string>; recent: number[]; focus?: number; focusAsked?: number; rng?: () => number },
): [number, number] | null {
  const rng = opts.rng ?? Math.random;
  if (cands.length < 2) return null;
  const recent = new Set(opts.recent);
  const draw = <T>(items: T[], weight: (t: T) => number): T | undefined => {
    const ws = items.map(weight);
    let r = rng() * ws.reduce((x, y) => x + y, 0);
    for (let i = 0; i < items.length; i++) if ((r -= ws[i]) <= 0) return items[i];
    return items[items.length - 1];
  };
  const fresh = cands.filter((c) => !recent.has(c.id));
  const first =
    opts.focus !== undefined
      ? cands.find((c) => c.id === opts.focus)
      : draw(fresh.length ? fresh : cands, (c) => (0.3 + c.score / 10) / (1 + c.n));
  if (!first) return null;
  const others = cands.filter((c) => c.id !== first.id);
  const unasked = others.filter((c) => !opts.asked.has(pairKey(first.id, c.id)));
  const pool = [unasked.filter((c) => !recent.has(c.id)), unasked, others].find((l) => l.length)!;
  // Only people close in score: a question between two people far apart has an obvious answer
  // and teaches nothing. Take everyone within `window` of the first person; if that's fewer than
  // `nearest`, take the `nearest` closest instead. When placing one person, start a little wider
  // (their estimate may be off) and close in as answers pin them down.
  const asked = opts.focusAsked ?? 0;
  const focusing = opts.focus !== undefined;
  const window = focusing ? Math.max(0.5, 1.5 - 0.25 * asked) : 0.75;
  const nearest = focusing ? Math.max(3, 6 - asked) : 4;
  const dist = (c: WebCandidate) => Math.abs(c.score - first.score);
  const sorted = [...pool].sort((x, y) => dist(x) - dist(y));
  const within = sorted.filter((c) => dist(c) <= window);
  const near = within.length >= nearest ? within : sorted.slice(0, nearest);
  const spread = Math.max(0.25, window / 2);
  const second = draw(near, (c) => Math.exp(-dist(c) / spread) / Math.sqrt(1 + c.n));
  if (!second) return null;
  return rng() < 0.5 ? [first.id, second.id] : [second.id, first.id];
}

/** Stored scores keep two decimals so many people can fit between two others. */
const round2 = (n: number) => Math.round(n * 100) / 100;

export function round1(n: number) {
  return Math.round(n * 10) / 10;
}

const clamp = (n: number) => Math.max(0, Math.min(10, n));
