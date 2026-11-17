import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Avatar, Empty, PageHead, ScoreBadge } from '@/components/ui';
import { listPeople, type PersonListRow } from '@/db/people';
import { loadScores, setPlacement } from '@/db/ranking';
import {
  answerPlacement,
  assignRanks,
  describeScoreInfo,
  nextOpponent,
  nextToPlace,
  placedScore,
  questionsLeft,
  startPlacement,
  type Placement,
  type ScoreInfo,
} from '@/lib/ranking';
import { useQuery, useStore } from '@/lib/store';

type Pool = { people: Map<number, PersonListRow>; scores: Map<number, ScoreInfo> };

type Mode =
  | { kind: 'overview'; notice?: string }
  | {
      kind: 'play';
      placement: Placement;
      /** Started from "rank this person": stop after them instead of carrying on. */
      single: boolean;
      round: number;
      last?: string;
      skip: Set<number>;
      pool: Pool;
    };

const LIST_PAGE = 50;

export function Rank() {
  const { db, bump } = useStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>({ kind: 'overview' });
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(LIST_PAGE);

  const data = useQuery(async (): Promise<Pool> => {
    const people = await listPeople(db, { status: ['new', 'backlog', 'reviewed'] });
    const scores = await loadScores(db, people);
    return { people: new Map(people.map((p) => [p.id, p])), scores };
  });

  /** Everyone with a score, closest first: who you get compared against. */
  const ladder = (pool: Pool, without: number) =>
    [...pool.scores]
      .filter(([id, s]) => id !== without && s.score > 0)
      .sort((a, b) => b[1].score - a[1].score)
      .map(([id, s]) => ({ id, score: s.score }));

  const begin = (pool: Pool, personId: number, opts: { single: boolean; round: number; skip: Set<number>; last?: string }) => {
    const placement = startPlacement(personId, ladder(pool, personId));
    if (nextOpponent(placement) === null) return finish(pool, placement, { ...opts });
    setMode({ kind: 'play', placement, pool, ...opts });
  };

  const play = (pool: Pool, round: number, skip: Set<number>, last?: string) => {
    const next = nextToPlace(pool.scores, skip);
    if (next === null) {
      bump();
      return setMode({ kind: 'overview', notice: last ? `${last} That's everyone for now. Nice work!` : 'Nobody to rank yet. Import some chats or contacts first.' });
    }
    begin(pool, next, { single: false, round, skip, last });
  };

  /** Save a score and update the in-memory pool so the next round sees it straight away. */
  const commit = async (pool: Pool, personId: number, score: number) => {
    const prev = pool.scores.get(personId)!;
    await setPlacement(db, personId, score, prev.activity);
    const scores = new Map(pool.scores);
    scores.set(personId, { ...prev, score, placed: true, drift: 0, rankedAt: new Date().toISOString(), drifting: false, growing: false });
    assignRanks(scores);
    return { ...pool, scores };
  };

  const finish = async (pool: Pool, placement: Placement, opts: { single: boolean; round: number; skip: Set<number> }) => {
    const score = placedScore(placement);
    const fresh = await commit(pool, placement.personId, score);
    const s = fresh.scores.get(placement.personId)!;
    const text = `${pool.people.get(placement.personId)?.name} → ${score.toFixed(1)} (#${s.rank}).`;
    const skip = new Set(opts.skip).add(placement.personId);
    if (opts.single) {
      bump();
      return setMode({ kind: 'overview', notice: text });
    }
    play(fresh, opts.round + 1, skip, text);
  };

  // /rank?person=12 jumps straight into placing that person.
  const requested = Number(params.get('person')) || null;
  useEffect(() => {
    if (requested && data?.people.has(requested)) {
      setParams({}, { replace: true });
      begin(data, requested, { single: true, round: 1, skip: new Set() });
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

  /* ---------- the game ---------- */
  if (mode.kind === 'play') {
    const { placement, pool } = mode;
    const a = pool.people.get(placement.personId)!;
    const b = pool.people.get(nextOpponent(placement)!)!;
    const left = questionsLeft(placement);
    const answer = (x: 'new' | 'other' | 'tie') => {
      const next = answerPlacement(placement, x);
      if (nextOpponent(next) === null) finish(pool, next, mode);
      else setMode({ ...mode, placement: next });
    };
    const notClose = async () => {
      const fresh = await commit(pool, a.id, 0);
      const text = `${a.name} → 0 (not close).`;
      if (mode.single) {
        bump();
        return setMode({ kind: 'overview', notice: text });
      }
      play(fresh, mode.round + 1, new Set(mode.skip).add(a.id), text);
    };
    const skip = () => (mode.single ? setMode({ kind: 'overview' }) : play(pool, mode.round, new Set(mode.skip).add(a.id), mode.last));
    return (
      <div className="page rank-page">
        <div className="row-gap">
          <button type="button" className="btn ghost" onClick={() => { bump(); setMode({ kind: 'overview', notice: mode.last }); }}>
            ← {mode.single ? 'Back' : 'Done for now'}
          </button>
          {mode.last && <span className="small muted" role="status">{mode.last}</span>}
        </div>
        <Matchup
          question="Who are you closer to these days?"
          hint={`${mode.single ? '' : `Round ${mode.round} · `}placing ${a.name} · about ${left} more ${left === 1 ? 'question' : 'questions'}`}
          a={a}
          b={b}
          onA={() => answer('new')}
          onB={() => answer('other')}
          onTie={() => answer('tie')}
        />
        <div className="row-gap rank-extra">
          <button type="button" className="btn ghost small" onClick={skip}>Skip {a.name.split(' ')[0]}</button>
          <button type="button" className="btn ghost small" onClick={notClose}>Not close to {a.name.split(' ')[0]} anymore</button>
        </div>
      </div>
    );
  }

  /* ---------- overview ---------- */
  const upNextId = nextToPlace(data.scores, new Set());
  const upNext = upNextId !== null ? data.people.get(upNextId) : undefined;
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
            Answer “who are you closer to?” Each round places one person, and you can keep going as long as you like. The game starts with people it has only guessed at, then
            re-checks anyone whose score has moved.
          </p>
          {upNext && (
            <p className="small">
              Up next: <strong>{upNext.name}</strong>
            </p>
          )}
          <button type="button" className="btn primary" disabled={!upNext || everyone.length < 2} onClick={() => play(data, 1, new Set())}>
            {everyone.length < 2 ? 'Import chats or contacts first' : 'Play'}
          </button>
          <p className="muted small">
            {placedCount} placed by you · {everyone.length - placedCount} still guessed from activity
          </p>
        </section>
        <section className="card pad stack">
          <h2 className="card-title">🔎 Rank someone specific</h2>
          <input className="input" type="search" placeholder="Search anyone…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search people to rank" />
          <ul className="list">
            {found.map((p) => (
              <li key={p.id} className="person-row">
                <button type="button" className="person-link pick-btn" onClick={() => begin(data, p.id, { single: true, round: 1, skip: new Set() })}>
                  <Avatar name={p.name} photo={p.photo} size={32} />
                  <span className="person-text">
                    <span className="person-name">{p.name}</span>
                  </span>
                </button>
                <div className="person-right">
                  <ScoreBadge score={data.scores.get(p.id)?.score ?? 0} />
                </div>
              </li>
            ))}
          </ul>
          {q && !found.length && <p className="muted small">No one by that name.</p>}
        </section>
      </div>

      {growing.length > 0 && (
        <MiniList title="Growing closer · you've talked a lot more lately" rows={growing} sub={(s) => `+${s.drift.toFixed(1)} since you placed them`} onRerank={(id) => begin(data, id, { single: true, round: 1, skip: new Set() })} />
      )}
      {drifting.length > 0 && (
        <MiniList title="Drifting apart · reach out?" rows={drifting} sub={(s) => `${s.drift.toFixed(1)} since you placed them`} onRerank={(id) => begin(data, id, { single: true, round: 1, skip: new Set() })} />
      )}

      {everyone.length === 0 ? (
        <Empty>No scores yet. Import your Instagram, Facebook or Discord messages, or search for someone above to rank them.</Empty>
      ) : (
        <section>
          <h2 className="section-title">Everyone, closest first · {everyone.length}</h2>
          <ol className="list card rank-list">
            {everyone.slice(0, shown).map(({ p, s }) => (
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
                  <ScoreBadge score={s.score} guess={!s.placed} />
                  <button type="button" className="btn ghost small" onClick={() => begin(data, p.id, { single: true, round: 1, skip: new Set() })}>
                    {s.placed ? 'Re-rank' : 'Rank'}
                  </button>
                </div>
              </li>
            ))}
          </ol>
          {everyone.length > shown && (
            <button type="button" className="btn secondary" onClick={() => setShown((n) => n + LIST_PAGE * 2)}>
              Show more
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function MiniList({ title, rows, sub, onRerank }: { title: string; rows: { p: PersonListRow; s: ScoreInfo }[]; sub: (s: ScoreInfo) => string; onRerank: (id: number) => void }) {
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
              <ScoreBadge score={s.score} />
              <button type="button" className="btn ghost small" onClick={() => onRerank(p.id)}>Re-rank</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Matchup({ question, hint, a, b, onA, onB, onTie }: {
  question: string;
  hint: string;
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
