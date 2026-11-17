import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Chips, Empty, LabelMenu, PageHead, Pager, ScoreBadge, SourceIcon, TagChip } from '@/components/ui';
import { allTags, listPeople, updatePerson, type PersonListRow, type PersonStatus } from '@/db/people';
import { CIRCLES, circleInfo, SOURCE_LABELS, type Circle } from '@/lib/constants';
import { describeScoreInfo } from '@/lib/ranking';
import { inferCircle } from '@/lib/relationship';
import { loadScores } from '@/db/ranking';
import { nameReviewList } from '@/db/names';
import { listDuplicates } from '@/db/merge';
import { allCities, setArchived, setCity } from '@/db/people';
import { looksLikeOrganization } from '@/lib/orgs';
import { useQuery, useStore } from '@/lib/store';

type Filter = 'all' | 'reviewed' | 'todo' | 'archived';
const FILTER_STATUS: Record<Filter, PersonStatus[]> = {
  all: ['new', 'backlog', 'reviewed'],
  reviewed: ['reviewed'],
  todo: ['new', 'backlog'],
  archived: ['archived'],
};
type Sort = 'score' | 'name' | 'recent';
type CircleFilter = 'any' | Circle | 'unset' | 'org';

const PAGE = 50;

type Row = PersonListRow & { circleShown: Circle | null; guessed: boolean; score: number; guess: boolean; why: string };

export function People() {
  const { db, bump } = useStore();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [tag, setTag] = useState('');
  const [circle, setCircle] = useState<CircleFilter>('any');
  const [sort, setSort] = useState<Sort>('score');
  const [page, setPage] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<{ el: HTMLElement; row: Row } | null>(null);

  const people = useQuery(async () => {
    const list = await listPeople(db, { status: FILTER_STATUS[filter], search, tag: tag || undefined });
    return { list, scores: await loadScores(db, list) };
  }, [filter, search, tag]);
  const tags = useQuery(() => allTags(db), []);
  const cities = useQuery(() => allCities(db), []);
  const [city, setCityFilter] = useState('');
  const needNames = useQuery(async () => (await nameReviewList(db)).length, []) ?? 0;
  const dupes = useQuery(async () => (await listDuplicates(db)).filter((p) => p.strong).length, []) ?? 0;

  const rows = useMemo(() => {
    if (!people) return null;
    const out: Row[] = people.list.map((p) => {
      const guess = inferCircle(p.sources, !!p.stage);
      const s = people.scores.get(p.id)!;
      return { ...p, circleShown: p.circle ?? guess, guessed: !p.circle && !!guess, score: s.score, guess: !s.placed, why: describeScoreInfo(s) };
    });
    const filtered =
      circle === 'any'
        ? out
        : circle === 'org'
          ? out.filter((r) => looksLikeOrganization(r.name, r.ig_handle ? [r.ig_handle] : []))
          : out.filter((r) => (circle === 'unset' ? !r.circleShown : r.circleShown === circle || r.circleShown === 'both'));
    if (city) {
      const c = city.toLowerCase();
      for (let i = filtered.length - 1; i >= 0; i--) if ((filtered[i].city ?? '').toLowerCase() !== (c === '__none' ? '' : c)) filtered.splice(i, 1);
    }
    if (sort === 'score') filtered.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    if (sort === 'recent') filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return filtered;
  }, [people, circle, sort, city]);

  const bulkCity = async () => {
    const c = prompt(`City for ${selected.size.toLocaleString()} ${selected.size === 1 ? 'person' : 'people'} (e.g. Los Angeles, CA). Leave blank to clear.`, city && city !== '__none' ? city : '');
    if (c === null) return;
    await setCity(db, [...selected], c);
    setSelected(new Set());
    bump();
  };

  const bulkArchive = async (archive: boolean) => {
    const n = selected.size;
    if (archive && n > 20 && !confirm(`Archive ${n.toLocaleString()} people? They'll move to the Archived filter, and you can bring them back any time.`)) return;
    await setArchived(db, [...selected], archive);
    setSelected(new Set());
    bump();
  };

  // If filters shrink the list, stay on the last page that still exists.
  const pg = Math.min(page, Math.max(0, Math.ceil((rows?.length ?? 0) / PAGE) - 1));

  const resetPaging = <T,>(fn: (v: T) => void) => (v: T) => {
    setPage(0);
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
        {dupes > 0 && (
          <Link className="btn secondary" to="/duplicates" title="The same person imported twice">
            🔗 {dupes.toLocaleString()} possible {dupes === 1 ? 'duplicate' : 'duplicates'}
          </Link>
        )}
        {needNames > 0 && (
          <Link className="btn secondary" to="/names" title="Turn usernames into First Last">
            ✨ Clean up {needNames.toLocaleString()} {needNames === 1 ? 'name' : 'names'}
          </Link>
        )}
        <Link className="btn secondary" to="/rank">
          🏆 Rank friends
        </Link>
        <Link className="btn secondary" to="/followers">
          📸 Followers
        </Link>
        <button type="button" className={`btn ${selecting ? 'primary' : 'secondary'}`} onClick={() => { setSelecting((v) => !v); setSelected(new Set()); }}>
          {selecting ? 'Done selecting' : '☑ Select'}
        </button>
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
              { key: 'archived', label: 'Archived' },
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
              <option value="org">Looks like an organization</option>
            </select>
            <select className="input" value={tag} onChange={(e) => resetPaging(setTag)(e.target.value)} aria-label="Tag">
              <option value="">All tags</option>
              {tags?.map((t) => (
                <option key={t.tag} value={t.tag}>
                  {t.tag} ({t.n})
                </option>
              ))}
            </select>
            <select className="input" value={city} onChange={(e) => resetPaging(setCityFilter)(e.target.value)} aria-label="City">
              <option value="">All cities</option>
              {cities?.map((c) => (
                <option key={c.city} value={c.city}>
                  {c.city} ({c.n})
                </option>
              ))}
              <option value="__none">City not set</option>
            </select>
            <select className="input" value={sort} onChange={(e) => resetPaging(setSort)(e.target.value as Sort)} aria-label="Sort">
              <option value="score">Closest first</option>
              <option value="name">Name A–Z</option>
              <option value="recent">Recently added</option>
            </select>
          </div>
        </div>
      </div>

      {selecting && rows && (
        <div className="bulk-bar card" role="toolbar" aria-label="Selected people">
          <strong>{selected.size.toLocaleString()} selected</strong>
          <button type="button" className="btn ghost small" onClick={() => setSelected(new Set([...selected, ...rows.slice(pg * PAGE, (pg + 1) * PAGE).map((r) => r.id)]))}>
            Select this page
          </button>
          <button type="button" className="btn ghost small" onClick={() => setSelected(new Set(rows.map((r) => r.id)))}>
            Select all {rows.length.toLocaleString()}
          </button>
          {selected.size > 0 && (
            <button type="button" className="btn ghost small" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn secondary small" disabled={!selected.size} onClick={bulkCity}>
            📍 Set city
          </button>
          {filter === 'archived' ? (
            <button type="button" className="btn primary small" disabled={!selected.size} onClick={() => bulkArchive(false)}>
              Unarchive {selected.size || ''}
            </button>
          ) : (
            <button type="button" className="btn primary small" disabled={!selected.size} onClick={() => bulkArchive(true)}>
              Archive {selected.size || ''}
            </button>
          )}
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="card people-table" role="table" aria-label="People">
          <div className="pt-row pt-head" role="row">
            <span role="columnheader">Person</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Tags</span>
            <span role="columnheader" title="0–10. Faded = guessed from how much you talk; play Rank to set it yourself.">
              Closeness
            </span>
            <span role="columnheader">Connected on</span>
          </div>
          {rows.slice(pg * PAGE, (pg + 1) * PAGE).map((r, j) => {
            const i = pg * PAGE + j;
            const c = circleInfo(r.circleShown);
            return (
              <div key={r.id} className={`pt-row${r.status === 'archived' ? ' dim' : ''}`} role="row">
                {selecting ? (
                  <label className="pt-person selectable" role="cell">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(r.id);
                        else next.delete(r.id);
                        setSelected(next);
                      }}
                      aria-label={`Select ${r.name}`}
                    />
                    <Avatar name={r.name} photo={r.photo} size={36} />
                    <span className="person-text">
                      <span className="person-name">{r.name}</span>
                      <span className="person-sub">{[r.city && `📍 ${r.city}`, r.how_met, r.company].filter(Boolean).join(' · ') || handleOf(r)}</span>
                    </span>
                  </label>
                ) : (
                  <Link to={`/person/${r.id}`} className="pt-person" role="cell">
                    <Avatar name={r.name} photo={r.photo} size={36} />
                    <span className="person-text">
                      <span className="person-name">{r.name}</span>
                      <span className="person-sub">{[r.city && `📍 ${r.city}`, r.how_met, r.company].filter(Boolean).join(' · ') || handleOf(r)}</span>
                    </span>
                  </Link>
                )}
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
                  <ScoreBadge score={r.score} rank={sort === 'score' && r.score > 0 ? i + 1 : undefined} title={r.why} guess={r.guess} />
                </span>
                <span className="pt-sources badges" role="cell">
                  {r.sources.map((s) => <SourceIcon key={s} source={s} href={r.links[s]} />)}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {rows && <Pager page={pg} pageSize={PAGE} count={rows.length} onChange={setPage} />}
      {rows && rows.length === 0 && <Empty>{search || tag || city || circle !== 'any' ? 'No matches.' : 'No one here yet.'}</Empty>}

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
