import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Chips, Empty, LabelMenu, PageHead, ScoreBadge, SourceBadge, TagChip } from '@/components/ui';
import { allTags, listPeople, updatePerson, type PersonListRow, type PersonStatus } from '@/db/people';
import { CIRCLES, circleInfo, SOURCE_LABELS, type Circle } from '@/lib/constants';
import { describeScoreInfo } from '@/lib/ranking';
import { inferCircle } from '@/lib/relationship';
import { loadScores } from '@/db/ranking';
import { useQuery, useStore } from '@/lib/store';

type Filter = 'all' | 'reviewed' | 'todo' | 'archived';
const FILTER_STATUS: Record<Filter, PersonStatus[]> = {
  all: ['new', 'backlog', 'reviewed'],
  reviewed: ['reviewed'],
  todo: ['new', 'backlog'],
  archived: ['archived'],
};
type Sort = 'score' | 'name' | 'recent';
type CircleFilter = 'any' | Circle | 'unset';

const PAGE = 150;

type Row = PersonListRow & { circleShown: Circle | null; guessed: boolean; score: number; why: string };

export function People() {
  const { db, bump } = useStore();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [tag, setTag] = useState('');
  const [circle, setCircle] = useState<CircleFilter>('any');
  const [sort, setSort] = useState<Sort>('score');
  const [shown, setShown] = useState(PAGE);
  const [menu, setMenu] = useState<{ el: HTMLElement; row: Row } | null>(null);

  const people = useQuery(async () => {
    const list = await listPeople(db, { status: FILTER_STATUS[filter], search, tag: tag || undefined });
    return { list, scores: await loadScores(db, list) };
  }, [filter, search, tag]);
  const tags = useQuery(() => allTags(db), []);

  const rows = useMemo(() => {
    if (!people) return null;
    const out: Row[] = people.list.map((p) => {
      const guess = inferCircle(p.sources, !!p.stage);
      const s = people.scores.get(p.id)!;
      return { ...p, circleShown: p.circle ?? guess, guessed: !p.circle && !!guess, score: s.score, why: describeScoreInfo(s) };
    });
    const filtered = circle === 'any' ? out : out.filter((r) => (circle === 'unset' ? !r.circleShown : r.circleShown === circle || r.circleShown === 'both'));
    if (sort === 'score') filtered.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    if (sort === 'recent') filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return filtered;
  }, [people, circle, sort]);

  const resetPaging = <T,>(fn: (v: T) => void) => (v: T) => {
    setShown(PAGE);
    fn(v);
  };

  const pickCircle = async (c: Circle | null) => {
    if (!menu) return;
    await updatePerson(db, menu.row.id, { circle: c });
    setMenu(null);
    bump();
  };

  return (
    <div className="page page-wide">
      <PageHead title="People" sub={rows ? `${rows.length.toLocaleString()} ${rows.length === 1 ? 'person' : 'people'}` : undefined}>
        <Link className="btn secondary" to="/rank">
          🏆 Rank friends
        </Link>
        <Link className="btn primary" to="/person/new">
          + Add person
        </Link>
      </PageHead>
      <div className="toolbar">
        <input
          type="search"
          className="input"
          placeholder="Search names, tags, @handles, companies, notes…"
          value={search}
          onChange={(e) => resetPaging(setSearch)(e.target.value)}
          aria-label="Search people"
        />
        <div className="filter-row">
          <Chips
            label="Filter"
            options={[
              { key: 'all', label: 'All' },
              { key: 'reviewed', label: 'Filled in' },
              { key: 'todo', label: 'To fill in' },
              { key: 'archived', label: 'Skipped' },
            ]}
            value={filter}
            onChange={resetPaging(setFilter)}
          />
          <div className="row-gap selects">
            <select className="input" value={circle} onChange={(e) => resetPaging(setCircle)(e.target.value as CircleFilter)} aria-label="Personal or professional">
              <option value="any">Personal & professional</option>
              <option value="personal">Personal</option>
              <option value="professional">Professional</option>
              <option value="unset">Type not set</option>
            </select>
            <select className="input" value={tag} onChange={(e) => resetPaging(setTag)(e.target.value)} aria-label="Tag">
              <option value="">All tags</option>
              {tags?.map((t) => (
                <option key={t.tag} value={t.tag}>
                  {t.tag} ({t.n})
                </option>
              ))}
            </select>
            <select className="input" value={sort} onChange={(e) => resetPaging(setSort)(e.target.value as Sort)} aria-label="Sort">
              <option value="score">Closest first</option>
              <option value="name">Name A–Z</option>
              <option value="recent">Recently added</option>
            </select>
          </div>
        </div>
      </div>

      {rows && rows.length > 0 && (
        <div className="card people-table" role="table" aria-label="People">
          <div className="pt-row pt-head" role="row">
            <span role="columnheader">Person</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Tags</span>
            <span role="columnheader" title="0–10: your ranking (or hearts) plus how much you've been talking lately">
              Closeness
            </span>
            <span role="columnheader">Connected on</span>
          </div>
          {rows.slice(0, shown).map((r, i) => {
            const c = circleInfo(r.circleShown);
            return (
              <div key={r.id} className={`pt-row${r.status === 'archived' ? ' dim' : ''}`} role="row">
                <Link to={`/person/${r.id}`} className="pt-person" role="cell">
                  <Avatar name={r.name} photo={r.photo} size={36} />
                  <span className="person-text">
                    <span className="person-name">{r.name}</span>
                    <span className="person-sub">{[r.how_met, r.company].filter(Boolean).join(' · ') || handleOf(r)}</span>
                  </span>
                </Link>
                <span className="pt-type" role="cell">
                  <button
                    type="button"
                    className={`pill pill-sm${c ? '' : ' unset'}${r.guessed ? ' guessed' : ''}`}
                    style={c ? { background: c.color } : undefined}
                    title={r.guessed ? `Guessed from ${r.sources.map((s) => SOURCE_LABELS[s] ?? s).join(', ')}. Click to set.` : 'Click to change'}
                    onClick={(e) => setMenu({ el: e.currentTarget, row: r })}
                  >
                    {c ? c.label : '+ Type'}
                  </button>
                </span>
                <span className="pt-tags" role="cell">
                  {r.tags.map((t) => (
                    <button key={t} type="button" className="tag-btn" onClick={() => resetPaging(setTag)(t)} title={`Show everyone tagged ${t}`}>
                      <TagChip tag={t} />
                    </button>
                  ))}
                </span>
                <span className="pt-score" role="cell">
                  <ScoreBadge score={r.score} rank={sort === 'score' && r.score > 0 ? i + 1 : undefined} title={r.why} />
                </span>
                <span className="pt-sources badges" role="cell">
                  {r.sources.map((s) => <SourceBadge key={s} source={s} />)}
                </span>
              </div>
            );
          })}
          {rows.length > shown && (
            <button type="button" className="btn ghost block" onClick={() => setShown((n) => n + PAGE * 2)}>
              Show more ({(rows.length - shown).toLocaleString()} left)
            </button>
          )}
        </div>
      )}
      {rows && rows.length === 0 && <Empty>{search || tag || circle !== 'any' ? 'No matches.' : 'No one here yet.'}</Empty>}

      <LabelMenu
        anchor={menu?.el ?? null}
        title={menu?.row.name}
        options={CIRCLES}
        current={menu?.row.circle ?? null}
        clearLabel={menu?.row.circle ? 'Clear (go back to the guess)' : 'Leave unset'}
        onPick={pickCircle}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

function handleOf(r: PersonListRow) {
  return r.phone || r.email || '';
}
