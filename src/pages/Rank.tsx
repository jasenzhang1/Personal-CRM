import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Avatar, Empty, PageHead, ScoreBadge } from '@/components/ui';
import { listPeople, type PersonListRow } from '@/db/people';
import { confirmRanking, listRanking, loadScores, placePerson, removeRanking, swapRanking } from '@/db/ranking';
import {
  answerPlacement,
  nextOpponent,
  questionsLeft,
  startPlacement,
  tierFromHearts,
  tierInfo,
  TIERS,
  type Placement,
  type RankedRow,
  type ScoreInfo,
  type Tier,
} from '@/lib/ranking';
import { useQuery, useStore } from '@/lib/store';

type Mode =
  | { kind: 'overview' }
  | { kind: 'tier'; personId: number }
  | { kind: 'place'; placement: Placement }
  | { kind: 'checkin'; subjectId: number; opponentId: number; dir: 'up' | 'down'; triedDown: boolean; asked: number; moved: number }
  | { kind: 'done'; text: string };

const CHECKIN_QUESTIONS = 6;

export function Rank() {
  const { db, bump } = useStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>({ kind: 'overview' });
  const [search, setSearch] = useState('');

  const data = useQuery(async () => {
    const people = await listPeople(db, { status: ['new', 'backlog', 'reviewed'] });
    const ranking = await listRanking(db);
    const scores = await loadScores(db, people);
    return { people: new Map(people.map((p) => [p.id, p])), ranking, scores };
  });

  // /rank?person=12 jumps straight into placing that person.
  const requested = Number(params.get('person')) || null;
  useEffect(() => {
    if (requested && data?.people.has(requested)) {
      setMode({ kind: 'tier', personId: requested });
      setParams({}, { replace: true });
    }
  }, [requested, data, setParams]);

  const unranked = useMemo(() => {
    if (!data) return [];
    const ranked = new Set(data.ranking.map((r) => r.person_id));
    return [...data.people.values()]
      .filter((p) => !ranked.has(p.id))
      .map((p) => ({ p, s: data.scores.get(p.id)! }))
      .sort((a, b) => b.s.activity - a.s.activity || b.p.closeness - a.p.closeness || a.p.name.localeCompare(b.p.name));
  }, [data]);

  if (!data) return null;
  const person = (id: number) => data.people.get(id);
  const ranking = data.ranking;

  /* ---------- placing ---------- */
  const chooseTier = async (personId: number, tier: Tier) => {
    const order = ranking.filter((r) => r.tier === tier).map((r) => r.person_id);
    const p = startPlacement(personId, tier, order);
    if (nextOpponent(p) === null) await finishPlacement(p);
    else setMode({ kind: 'place', placement: p });
  };

  const finishPlacement = async (p: Placement) => {
    await placePerson(db, p.personId, p.tier, p.lo);
    const fresh = await listRanking(db);
    const overall = fresh.findIndex((r) => r.person_id === p.personId) + 1;
    bump();
    setMode({ kind: 'done', text: `${person(p.personId)?.name} is #${overall} overall, #${p.lo + 1} in ${tierInfo(p.tier)!.label}.` });
  };

  const answer = async (a: 'new' | 'other' | 'tie') => {
    if (mode.kind !== 'place') return;
    const next = answerPlacement(mode.placement, a);
    if (nextOpponent(next) === null) await finishPlacement(next);
    else setMode({ kind: 'place', placement: next });
  };

  /* ---------- quick check-in ---------- */
  const startCheckin = (asked = 0, moved = 0, rows: RankedRow[] = ranking) => {
    if (rows.length < 2 || asked >= CHECKIN_QUESTIONS) {
      bump();
      return setMode({ kind: 'done', text: moved ? `Rankings refreshed: ${moved} ${moved === 1 ? 'person moved' : 'people moved'}.` : 'Rankings confirmed. Nothing changed.' });
    }
    // Whoever you confirmed longest ago (ties broken randomly) gets checked against their neighbours.
    const stale = [...rows].sort((a, b) => a.ranked_at.localeCompare(b.ranked_at) || Math.random() - 0.5)[0];
    const k = rows.findIndex((r) => r.person_id === stale.person_id);
    if (k > 0) setMode({ kind: 'checkin', subjectId: stale.person_id, opponentId: rows[k - 1].person_id, dir: 'up', triedDown: false, asked, moved });
    else setMode({ kind: 'checkin', subjectId: stale.person_id, opponentId: rows[k + 1].person_id, dir: 'down', triedDown: true, asked, moved });
  };

  const answerCheckin = async (pick: 'subject' | 'opponent' | 'tie') => {
    if (mode.kind !== 'checkin') return;
    const rows = await listRanking(db);
    const s = rows.find((r) => r.person_id === mode.subjectId)!;
    const o = rows.find((r) => r.person_id === mode.opponentId)!;
    const asked = mode.asked + 1;
    const moves = (mode.dir === 'up' && pick === 'subject') || (mode.dir === 'down' && pick === 'opponent');
    if (moves) {
      await swapRanking(db, s, o);
      const after = await listRanking(db);
      const k = after.findIndex((r) => r.person_id === s.person_id);
      const nextIdx = mode.dir === 'up' ? k - 1 : k + 1;
      if (asked < CHECKIN_QUESTIONS && after[nextIdx])
        return setMode({ ...mode, opponentId: after[nextIdx].person_id, asked, moved: mode.moved + 1 });
      return startCheckin(asked, mode.moved + 1, after);
    }
    if (pick !== 'tie' && mode.dir === 'up' && !mode.triedDown) {
      const k = rows.findIndex((r) => r.person_id === s.person_id);
      if (rows[k + 1] && asked < CHECKIN_QUESTIONS)
        return setMode({ ...mode, opponentId: rows[k + 1].person_id, dir: 'down', triedDown: true, asked });
    }
    await confirmRanking(db, s.person_id, o.person_id);
    startCheckin(asked, mode.moved, await listRanking(db));
  };

  /* ---------- views ---------- */
  if (mode.kind === 'tier') {
    const p = person(mode.personId);
    if (!p) return null;
    const suggested = tierFromHearts(p.closeness);
    const current = ranking.find((r) => r.person_id === p.id)?.tier;
    return (
      <div className="page rank-page">
        <BackBar onBack={() => setMode({ kind: 'overview' })} />
        <div className="rank-hero">
          <Avatar name={p.name} photo={p.photo} size={96} />
          <h1>How close are you to {p.name}?</h1>
        </div>
        <div className="tier-picks">
          {TIERS.map((t) => (
            <button key={t.key} type="button" className={`tier-pick${t.key === (current ?? suggested) ? ' suggested' : ''}`} style={{ ['--tier' as string]: t.color }} onClick={() => chooseTier(p.id, t.key)}>
              <span className="tier-emoji">{t.emoji}</span>
              <strong>{t.label}</strong>
              <span className="muted small">{t.hint}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (mode.kind === 'place') {
    const a = person(mode.placement.personId)!;
    const b = person(nextOpponent(mode.placement)!)!;
    const left = questionsLeft(mode.placement);
    return (
      <div className="page rank-page">
        <BackBar onBack={() => setMode({ kind: 'overview' })} />
        <Matchup
          question="Who are you closer to?"
          hint={`${tierInfo(mode.placement.tier)!.emoji} ${tierInfo(mode.placement.tier)!.label} · about ${left} more ${left === 1 ? 'question' : 'questions'}`}
          a={a}
          b={b}
          onA={() => answer('new')}
          onB={() => answer('other')}
          onTie={() => answer('tie')}
        />
      </div>
    );
  }

  if (mode.kind === 'checkin') {
    const s = person(mode.subjectId);
    const o = person(mode.opponentId);
    if (!s || !o) return null;
    // Keep the higher-ranked person on the left so it reads naturally.
    const [left, right] = mode.dir === 'up' ? [o, s] : [s, o];
    const pick = (who: PersonListRow) => answerCheckin(who.id === s.id ? 'subject' : 'opponent');
    return (
      <div className="page rank-page">
        <BackBar onBack={() => { bump(); setMode({ kind: 'overview' }); }} />
        <Matchup
          question="These days, who are you closer to?"
          hint={`Quick check-in · ${mode.asked + 1} of ${CHECKIN_QUESTIONS}`}
          a={left}
          b={right}
          onA={() => pick(left)}
          onB={() => pick(right)}
          onTie={() => answerCheckin('tie')}
          tieLabel="About the same"
        />
      </div>
    );
  }

  const topUnranked = unranked.filter((u) => !search || u.p.name.toLowerCase().includes(search.toLowerCase())).slice(0, search ? 30 : 8);
  const drifting = [...data.scores].filter(([, s]) => s.drifting).map(([id, s]) => ({ p: person(id)!, s })).filter((x) => x.p).sort((a, b) => (b.s.feel ?? 0) - (a.s.feel ?? 0)).slice(0, 6);

  return (
    <div className="page rank-page">
      <PageHead title="Rank" sub="Rank friends against each other, Beli-style. Scores also rise and fall with how much you actually talk." />

      {mode.kind === 'done' && (
        <p className="notice" role="status">
          🎉 {mode.text}{' '}
          {unranked[0] && (
            <button type="button" className="link-btn" style={{ color: 'var(--primary)' }} onClick={() => setMode({ kind: 'tier', personId: unranked[0].p.id })}>
              Rank {unranked[0].p.name} next →
            </button>
          )}
        </p>
      )}

      <div className="rank-actions">
        <section className="card pad stack">
          <h2 className="card-title">⚡ Quick check-in</h2>
          <p className="muted small">Friendships change. Answer {CHECKIN_QUESTIONS} quick matchups and anyone who's grown closer moves up.</p>
          <button type="button" className="btn primary" disabled={ranking.length < 2} onClick={() => startCheckin()}>
            {ranking.length < 2 ? 'Rank 2+ people first' : 'Start check-in'}
          </button>
        </section>
        <section className="card pad stack">
          <h2 className="card-title">➕ Rank someone</h2>
          <input className="input" type="search" placeholder="Search anyone…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search people to rank" />
          {!search && topUnranked.length > 0 && <p className="muted small">Suggested: the people you talk to most.</p>}
          <ul className="list">
            {topUnranked.map(({ p, s }) => (
              <li key={p.id} className="person-row">
                <button type="button" className="person-link pick-btn" onClick={() => setMode({ kind: 'tier', personId: p.id })}>
                  <Avatar name={p.name} photo={p.photo} size={32} />
                  <span className="person-text">
                    <span className="person-name">{p.name}</span>
                    {s.activity > 0 && <span className="person-sub">Activity {s.activity.toFixed(1)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!topUnranked.length && <p className="muted small">{search ? 'No one by that name left to rank.' : 'Everyone is ranked!'}</p>}
        </section>
      </div>

      {drifting.length > 0 && (
        <section>
          <h2 className="section-title">Drifting apart · reach out?</h2>
          <ul className="list card">
            {drifting.map(({ p, s }) => (
              <li key={p.id} className="person-row">
                <Link to={`/person/${p.id}`} className="person-link">
                  <Avatar name={p.name} photo={p.photo} size={32} />
                  <span className="person-text">
                    <span className="person-name">{p.name}</span>
                    <span className="person-sub">Close, but quiet lately{p.last_contacted ? ` · last talked ${p.last_contacted}` : ''}</span>
                  </span>
                </Link>
                <div className="person-right">
                  <ScoreBadge score={s.score} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ranking.length === 0 ? (
        <Empty>No one ranked yet. Pick someone above: choose a tier, then answer “who are you closer to?” a few times.</Empty>
      ) : (
        TIERS.map((t) => {
          const rows = ranking.filter((r) => r.tier === t.key);
          if (!rows.length) return null;
          return (
            <section key={t.key}>
              <h2 className="section-title" style={{ color: t.color }}>
                {t.emoji} {t.label} · {rows.length}
              </h2>
              <ol className="list card rank-list">
                {rows.map((r) => {
                  const p = person(r.person_id);
                  const s = data.scores.get(r.person_id);
                  if (!p || !s) return null;
                  return <RankRow key={r.person_id} p={p} s={s} onRerank={() => setMode({ kind: 'tier', personId: p.id })} onRemove={async () => { await removeRanking(db, p.id); bump(); }} onOpen={() => navigate(`/person/${p.id}`)} />;
                })}
              </ol>
            </section>
          );
        })
      )}
    </div>
  );
}

function RankRow({ p, s, onRerank, onRemove, onOpen }: { p: PersonListRow; s: ScoreInfo; onRerank: () => void; onRemove: () => void; onOpen: () => void }) {
  return (
    <li className="person-row">
      <span className="rank-num">{s.rank}</span>
      <button type="button" className="person-link pick-btn" onClick={onOpen}>
        <Avatar name={p.name} photo={p.photo} size={32} />
        <span className="person-text">
          <span className="person-name">{p.name}</span>
          <span className="person-sub">
            Ranking {s.feel?.toFixed(1)} · activity {s.activity.toFixed(1)}
            {s.drifting ? ' · drifting' : ''}
          </span>
        </span>
      </button>
      <div className="person-right">
        <ScoreBadge score={s.score} />
        <button type="button" className="btn ghost small" onClick={onRerank} title="Place them again">
          Re-rank
        </button>
        <button type="button" className="btn ghost small" onClick={onRemove} aria-label={`Remove ${p.name} from ranking`} title="Remove from ranking">
          ×
        </button>
      </div>
    </li>
  );
}

function Matchup({ question, hint, a, b, onA, onB, onTie, tieLabel = 'Too close to call' }: {
  question: string;
  hint: string;
  a: PersonListRow;
  b: PersonListRow;
  onA: () => void;
  onB: () => void;
  onTie: () => void;
  tieLabel?: string;
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
        {tieLabel}
      </button>
      <p className="muted small hide-mobile">Tip: ← and → keys pick, ↓ for a tie.</p>
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

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <div>
      <button type="button" className="btn ghost" onClick={onBack}>
        ← Back to rankings
      </button>
    </div>
  );
}
