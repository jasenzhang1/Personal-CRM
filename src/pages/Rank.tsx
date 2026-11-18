import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Avatar, EditableScore, Empty, PageHead, Pager } from '@/components/ui';
import { listPeople, type PersonListRow } from '@/db/people';
import { listComparisons, loadScores, recordComparison, refitWeb, setPlacement, setScoreByHand } from '@/db/ranking';
import {
  assignRanks,
  cyclePairs,
  describeScoreInfo,
  findCycle,
  pairKey,
  pickPair,
  scoreInfo,
  type Comparison,
  type ScoreInfo,
  type WebCandidate,
} from '@/lib/ranking';
import { useQuery, useStore } from '@/lib/store';

type Pool = { people: Map<number, PersonListRow>; scores: Map<number, ScoreInfo> };

type Play = {
  kind: 'play';
  pool: Pool;
  comps: Comparison[];
  /** Who's on screen, left and right. Null while showing a loop to sort out. */
  pair: [number, number] | null;
  answered: number;
  /** Recently shown people, kept out of the next few questions. */
  recent: number[];
  /** Started from "rank this person": they're in every question, for `total` questions. */
  focus?: { id: number; asked: number; total: number };
  /** Answers went in a circle: re-asking the older ones in it, one by one. */
  recheck?: { cycle: number[]; queue: [number, number][] };
  /** Still a circle after re-asking: shown so you can pick which answer is wrong. */
  loop?: number[];
  last?: string;
};
type Mode = { kind: 'overview'; notice?: string } | Play;
type Step = Omit<Play, 'kind' | 'pair'> & { pair?: [number, number] | null };

const LIST_PAGE = 50;
const RECENT = 8;

/** Who can come up in the game: anyone with a score, or anyone you've filled in, except people marked "not close". */
function candidates(pool: Pool, comps: Comparison[]): WebCandidate[] {
  const n = new Map<number, number>();
  for (const c of comps) for (const id of [c.a, c.b]) n.set(id, (n.get(id) ?? 0) + 1);
  const out: WebCandidate[] = [];
  for (const [id, s] of pool.scores) {
    const p = pool.people.get(id);
    if (!p || (s.placed && s.score <= 0)) continue;
    if (s.score > 0 || p.status === 'reviewed') out.push({ id, score: s.score, n: n.get(id) ?? 0 });
  }
  return out;
}

const askedPairs = (comps: Comparison[]) => new Set(comps.map((c) => pairKey(c.a, c.b)));
const findComp = (comps: Comparison[], x: number, y: number) => comps.find((c) => pairKey(c.a, c.b) === pairKey(x, y));
/** Winner first, or null for "about the same". */
const winnerLoser = (c: Comparison): [number, number] | null => (c.result === 'tie' ? null : c.result === 'a' ? [c.a, c.b] : [c.b, c.a]);
const replaceComp = (comps: Comparison[], c: Comparison) => [...comps.filter((k) => pairKey(k.a, k.b) !== pairKey(c.a, c.b)), c];

/** Is there still a circle through any of these pairs? */
function loopThrough(comps: Comparison[], cycle: number[]): number[] | null {
  for (const [x, y] of cyclePairs(cycle)) {
    const c = findComp(comps, x, y);
    const wl = c ? winnerLoser(c) : null;
    const found = wl ? findCycle(comps, wl[0], wl[1]) : null;
    if (found) return found;
  }
  return null;
}

const firstName = (p?: PersonListRow) => p?.name.split(' ')[0] ?? '?';

export function Rank() {
  const { db, bump } = useStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>({ kind: 'overview' });
  const [search, setSearch] = useState('');
  const [listPage, setListPage] = useState(0);
  const busy = useRef(false);

  const data = useQuery(async (): Promise<Pool> => {
    const people = await listPeople(db, { status: ['new', 'backlog', 'reviewed'] });
    const scores = await loadScores(db, people);
    return { people: new Map(people.map((p) => [p.id, p])), scores };
  });
  const webSize = useQuery(() => db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM comparisons'));

  /** Refit scores from all answers and update the in-memory pool so the next question sees them. */
  const refit = async (pool: Pool, touched: number[]): Promise<Pool> => {
    const rows = await refitWeb(db, pool.scores, touched);
    const scores = new Map(pool.scores);
    for (const [id, row] of rows) {
      const prev = scores.get(id);
      scores.set(id, scoreInfo({ row, hearts: pool.people.get(id)?.closeness ?? 0, activity: prev?.activity ?? 0 }));
    }
    assignRanks(scores);
    return { ...pool, scores };
  };

  /** You typed a score yourself on one of the lists. */
  const saveScore = async (id: number, score: number) => {
    await setScoreByHand(db, id, score, data?.scores.get(id)?.activity ?? 0);
    bump();
  };

  const toOverview = (notice?: string) => {
    bump();
    setMode({ kind: 'overview', notice });
  };

  /** Show the next question, a loop to sort out, or finish. */
  const advance = (st: Step) => {
    if (st.focus && st.focus.asked >= st.focus.total && !st.recheck && !st.loop) {
      const s = st.pool.scores.get(st.focus.id);
      return toOverview(`${st.pool.people.get(st.focus.id)?.name} → ${(s?.score ?? 0).toFixed(1)}${s?.rank ? ` (#${s.rank})` : ''}.`);
    }
    if (st.loop) return setMode({ ...st, kind: 'play', pair: null });
    const pair =
      st.pair ??
      st.recheck?.queue[0] ??
      pickPair(candidates(st.pool, st.comps), { asked: askedPairs(st.comps), recent: st.recent, focus: st.focus?.id, focusAsked: st.focus?.asked });
    if (!pair) return toOverview(st.last ? `${st.last} That's everyone for now.` : 'Not enough people to compare yet. Import some chats or contacts first.');
    setMode({ ...st, kind: 'play', pair, recent: [...pair, ...st.recent].slice(0, RECENT) });
  };

  const start = async (pool: Pool, focusId?: number) => {
    const comps = await listComparisons(db);
    const n = comps.filter((c) => c.a === focusId || c.b === focusId).length;
    advance({ pool, comps, answered: 0, recent: [], focus: focusId !== undefined ? { id: focusId, asked: 0, total: n ? 5 : 7 } : undefined });
  };

  /** "Jackie 5.2→6.4 · Sam 6.0→5.1" */
  const moved = (before: Pool, after: Pool, ids: number[]) =>
    ids
      .map((id) => `${firstName(after.people.get(id))} ${(before.scores.get(id)?.score ?? 0).toFixed(1)}→${(after.scores.get(id)?.score ?? 0).toFixed(1)}`)
      .join(' · ');

  const answer = async (st: Play, outcome: 'left' | 'right' | 'tie') => {
    if (busy.current || !st.pair) return;
    busy.current = true;
    try {
      const [x, y] = st.pair;
      const c = await recordComparison(db, x, y, outcome === 'left' ? 'x' : outcome === 'right' ? 'y' : 'tie');
      const comps = replaceComp(st.comps, c);
      const pool = await refit(st.pool, [x, y]);
      const last = moved(st.pool, pool, [x, y]);
      const focus = st.focus && { ...st.focus, asked: st.focus.asked + (st.recheck ? 0 : 1) };
      const next: Step = { ...st, pool, comps, focus, answered: st.answered + 1, pair: undefined, loop: undefined };

      if (st.recheck) {
        const queue = st.recheck.queue.slice(1);
        const still = loopThrough(comps, st.recheck.cycle);
        if (!still) return advance({ ...next, recheck: undefined, last: `Sorted out: your answers line up now. ${last}` });
        if (!queue.length) return advance({ ...next, recheck: undefined, loop: still, last });
        return advance({ ...next, recheck: { cycle: st.recheck.cycle, queue }, last });
      }
      const wl = winnerLoser(c);
      const cycle = wl ? findCycle(comps, wl[0], wl[1]) : null;
      if (cycle) {
        // Re-ask the older answers in the circle; the one just given is fresh.
        const queue = cyclePairs(cycle).filter(([p, q]) => pairKey(p, q) !== pairKey(x, y));
        return advance({ ...next, recheck: { cycle, queue }, last: `That answer goes in a circle with earlier ones, so let's double-check ${queue.length === 1 ? 'one' : queue.length}.` });
      }
      advance({ ...next, last });
    } finally {
      busy.current = false;
    }
  };

  /** Settle a circle that survived re-asking: flip one answer, or call them all about the same. */
  const settleLoop = async (st: Play, how: { flip: [number, number] } | 'tie' | 'leave') => {
    if (busy.current || !st.loop) return;
    busy.current = true;
    try {
      let comps = st.comps;
      const touched = new Set<number>();
      const save = async (x: number, y: number, outcome: 'x' | 'tie') => {
        comps = replaceComp(comps, await recordComparison(db, x, y, outcome));
        touched.add(x).add(y);
      };
      if (how === 'tie') for (const [x, y] of cyclePairs(st.loop)) await save(x, y, 'tie');
      else if (how !== 'leave') await save(how.flip[1], how.flip[0], 'x');
      const pool = touched.size ? await refit(st.pool, [...touched]) : st.pool;
      const last = how === 'leave' ? 'Left as is: their scores settle in between.' : how === 'tie' ? 'Marked them about the same.' : 'Flipped that answer.';
      advance({ ...st, pool, comps, pair: undefined, loop: undefined, last });
    } finally {
      busy.current = false;
    }
  };

  const notClose = async (st: Play, id: number) => {
    const prev = st.pool.scores.get(id);
    await setPlacement(db, id, 0, prev?.activity ?? 0);
    const scores = new Map(st.pool.scores);
    if (prev) scores.set(id, { ...prev, score: 0, placed: true, drift: 0, drifting: false, growing: false });
    assignRanks(scores);
    const comps = st.comps.filter((c) => c.a !== id && c.b !== id);
    const text = `${st.pool.people.get(id)?.name} → 0 (not close).`;
    if (st.focus?.id === id) return toOverview(text);
    advance({ ...st, pool: { ...st.pool, scores }, comps, pair: undefined, recheck: undefined, last: text });
  };

  const skip = (st: Play) => {
    if (st.recheck) {
      const queue = st.recheck.queue.slice(1);
      return advance({ ...st, pair: undefined, recheck: queue.length ? { ...st.recheck, queue } : undefined });
    }
    if (st.focus) return advance({ ...st, pair: undefined, focus: { ...st.focus, asked: st.focus.asked + 1 } });
    advance({ ...st, pair: undefined });
  };

  // /rank?person=12 jumps straight into ranking that person.
  const requested = Number(params.get('person')) || null;
  useEffect(() => {
    if (requested && data?.people.has(requested)) {
      setParams({}, { replace: true });
      start(data, requested);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, data]);

  const everyone = useMemo(() => {
    if (!data) return [];
    return [...data.scores]
      .filter(([, s]) => s.score > 0)
      .sort((a, b) => b[1].score - a[1].score)
      .map(([id, s]) => ({ p: data.people.get(id)!, s }))
      .filter((x) => x.p);
  }, [data]);

  if (!data) return null;
  const pg = Math.min(listPage, Math.max(0, Math.ceil(everyone.length / LIST_PAGE) - 1));
  const rankOne = (id: number) => start(data, id);

  /* ---------- the game ---------- */
  if (mode.kind === 'play') {
    const st = mode;
    const name = (id: number) => st.pool.people.get(id)?.name ?? '?';
    const back = (
      <div className="row-gap">
        <button type="button" className="btn ghost" onClick={() => toOverview(st.last)}>
          ← {st.focus ? 'Back' : 'Done for now'}
        </button>
        {st.last && <span className="small muted" role="status">{st.last}</span>}
      </div>
    );

    if (st.loop) {
      const loop = st.loop;
      return (
        <div className="page rank-page">
          {back}
          <section className="card pad stack loop-card">
            <h1>Your answers go in a circle</h1>
            <p className="muted">Even after double-checking, these can’t all be true at once. Which one is wrong? Or, if they really are about as close as each other, say so.</p>
            <ol className="list">
              {cyclePairs(loop).map(([p, q]) => (
                <li key={pairKey(p, q)} className="person-row">
                  <span className="grow">
                    Closer to <strong>{name(p)}</strong> than <strong>{name(q)}</strong>
                  </span>
                  <button type="button" className="btn secondary small" onClick={() => settleLoop(st, { flip: [p, q] })}>
                    Wrong: {firstName(st.pool.people.get(q))} is closer
                  </button>
                </li>
              ))}
            </ol>
            <div className="row-gap">
              <button type="button" className="btn primary" onClick={() => settleLoop(st, 'tie')}>
                They’re all about the same
              </button>
              <button type="button" className="btn ghost" onClick={() => settleLoop(st, 'leave')}>
                Leave it
              </button>
            </div>
          </section>
        </div>
      );
    }

    const [x, y] = st.pair!;
    const a = st.pool.people.get(x)!;
    const b = st.pool.people.get(y)!;
    const earlier = st.recheck ? findComp(st.comps, x, y) : undefined;
    const earlierWl = earlier ? winnerLoser(earlier) : null;
    const connected = new Set(st.comps.flatMap((c) => [c.a, c.b])).size;
    const circle = st.recheck ? [...st.recheck.cycle, st.recheck.cycle[0]].map((id) => firstName(st.pool.people.get(id))).join(' > ') : '';
    const hint = st.recheck
      ? `Double-checking: ${circle} can’t all be true`
      : st.focus
        ? `Ranking ${name(st.focus.id)} · question ${st.focus.asked + 1} of ${st.focus.total}`
        : `${st.answered} answered this session · ${connected.toLocaleString()} people in your web`;
    return (
      <div className="page rank-page">
        {back}
        <Matchup
          question={st.recheck ? 'Just to check: who are you closer to?' : 'Who are you closer to these days?'}
          hint={hint}
          note={earlierWl ? <>Earlier you said <strong>{name(earlierWl[0])}</strong>.</> : earlier ? <>Earlier you said they’re about the same.</> : undefined}
          a={a}
          b={b}
          onA={() => answer(st, 'left')}
          onB={() => answer(st, 'right')}
          onTie={() => answer(st, 'tie')}
        />
        <div className="row-gap rank-extra">
          <button type="button" className="btn ghost small" onClick={() => skip(st)}>
            Skip
          </button>
          {[a, b].map((p) => (
            <button key={p.id} type="button" className="btn ghost small" onClick={() => notClose(st, p.id)}>
              Not close to {firstName(p)} anymore
            </button>
          ))}
        </div>
      </div>
    );
  }

  /* ---------- overview ---------- */
  const canPlay = candidates(data, []).length >= 2;
  const placedCount = everyone.filter((x) => x.s.placed).length;
  const q = search.trim().toLowerCase();
  const found = q ? [...data.people.values()].filter((p) => p.name.toLowerCase().includes(q)).slice(0, 20) : [];
  const growing = everyone.filter((x) => x.s.growing).slice(0, 6);
  const drifting = everyone.filter((x) => x.s.drifting).sort((a, b) => a.s.drift - b.s.drift).slice(0, 6);

  return (
    <div className="page rank-page">
      <PageHead
        title="Rank"
        sub="Everyone gets one closeness score from 0 to 10. It starts as a guess from how much you talk. Comparing people sets it, and it keeps moving as you talk more or less."
      />

      {mode.notice && <p className="notice" role="status">🎉 {mode.notice}</p>}

      <div className="rank-actions">
        <section className="card pad stack">
          <h2 className="card-title">▶ Play</h2>
          <p className="muted small">
            Answer “who are you closer to?” for pairs drawn from everyone, mixed up every time. Each answer connects two people in a web, and every score is fitted to
            all your answers at once. If answers go in a circle (A over B over C over A), it asks again so you can untangle it. Stop whenever you like.
          </p>
          <button type="button" className="btn primary" disabled={!canPlay} onClick={() => start(data)}>
            {canPlay ? 'Play' : 'Import chats or contacts first'}
          </button>
          <p className="muted small">
            {(webSize?.n ?? 0).toLocaleString()} answers so far · {placedCount} people compared · {everyone.length - placedCount} still guessed from activity
          </p>
        </section>
        <section className="card pad stack">
          <h2 className="card-title">🔎 Rank someone specific</h2>
          <input className="input" type="search" placeholder="Search anyone…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search people to rank" />
          <ul className="list">
            {found.map((p) => (
              <li key={p.id} className="person-row">
                <button type="button" className="person-link pick-btn" onClick={() => rankOne(p.id)}>
                  <Avatar name={p.name} photo={p.photo} size={32} />
                  <span className="person-text">
                    <span className="person-name">{p.name}</span>
                  </span>
                </button>
                <div className="person-right">
                  <EditableScore score={data.scores.get(p.id)?.score ?? 0} guess={!data.scores.get(p.id)?.placed} onSave={(n) => saveScore(p.id, n)} />
                </div>
              </li>
            ))}
          </ul>
          {q && !found.length && <p className="muted small">No one by that name.</p>}
        </section>
      </div>

      {growing.length > 0 && (
        <MiniList title="Growing closer · you've talked a lot more lately" rows={growing} sub={(s) => `+${s.drift.toFixed(1)} since you placed them`} onRerank={rankOne} onSave={saveScore} />
      )}
      {drifting.length > 0 && (
        <MiniList title="Drifting apart · reach out?" rows={drifting} sub={(s) => `${s.drift.toFixed(1)} since you placed them`} onRerank={rankOne} onSave={saveScore} />
      )}

      {everyone.length === 0 ? (
        <Empty>No scores yet. Import your Instagram, Facebook or Discord messages, or search for someone above to rank them.</Empty>
      ) : (
        <section>
          <h2 className="section-title">Everyone, closest first · {everyone.length}</h2>
          <ol className="list card rank-list">
            {everyone.slice(pg * LIST_PAGE, (pg + 1) * LIST_PAGE).map(({ p, s }) => (
              <li key={p.id} className="person-row">
                <span className="rank-num">{s.rank}</span>
                <button type="button" className="person-link pick-btn" onClick={() => navigate(`/person/${p.id}`)}>
                  <Avatar name={p.name} photo={p.photo} size={32} />
                  <span className="person-text">
                    <span className="person-name">{p.name}</span>
                    <span className="person-sub">{s.placed ? describeScoreInfo(s) : '≈ guessed from activity'}</span>
                  </span>
                </button>
                <div className="person-right">
                  <EditableScore score={s.score} guess={!s.placed} onSave={(n) => saveScore(p.id, n)} />
                  <button type="button" className="btn ghost small" onClick={() => rankOne(p.id)}>
                    {s.placed ? 'Re-rank' : 'Rank'}
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <Pager page={pg} pageSize={LIST_PAGE} count={everyone.length} onChange={setListPage} />
        </section>
      )}
    </div>
  );
}

function MiniList({ title, rows, sub, onRerank, onSave }: { title: string; rows: { p: PersonListRow; s: ScoreInfo }[]; sub: (s: ScoreInfo) => string; onRerank: (id: number) => void; onSave: (id: number, score: number) => Promise<void> }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      <ul className="list card">
        {rows.map(({ p, s }) => (
          <li key={p.id} className="person-row">
            <Link to={`/person/${p.id}`} className="person-link">
              <Avatar name={p.name} photo={p.photo} size={32} />
              <span className="person-text">
                <span className="person-name">{p.name}</span>
                <span className="person-sub">{sub(s)}</span>
              </span>
            </Link>
            <div className="person-right">
              <EditableScore score={s.score} onSave={(n) => onSave(p.id, n)} />
              <button type="button" className="btn ghost small" onClick={() => onRerank(p.id)}>Re-rank</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Matchup({ question, hint, note, a, b, onA, onB, onTie }: {
  question: string;
  hint: string;
  note?: ReactNode;
  a: PersonListRow;
  b: PersonListRow;
  onA: () => void;
  onB: () => void;
  onTie: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') onA();
      else if (e.key === 'ArrowRight') onB();
      else if (e.key === 'ArrowDown' || e.key === '=') onTie();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onA, onB, onTie]);
  return (
    <div className="matchup">
      <h1>{question}</h1>
      <p className="muted small">{hint}</p>
      {note && <p className="small">{note}</p>}
      <div className="matchup-cards">
        <MatchCard p={a} onClick={onA} />
        <span className="vs">or</span>
        <MatchCard p={b} onClick={onB} />
      </div>
      <button type="button" className="btn secondary" onClick={onTie}>
        About the same
      </button>
      <p className="muted small hide-mobile">Tip: ← and → keys pick, ↓ for “about the same”.</p>
    </div>
  );
}

function MatchCard({ p, onClick }: { p: PersonListRow; onClick: () => void }) {
  const sub = p.how_met || p.company || p.tags.slice(0, 2).join(' · ');
  return (
    <button type="button" className="match-card card" onClick={onClick}>
      <Avatar name={p.name} photo={p.photo} size={88} />
      <strong>{p.name}</strong>
      {sub && <span className="muted small">{sub}</span>}
    </button>
  );
}
