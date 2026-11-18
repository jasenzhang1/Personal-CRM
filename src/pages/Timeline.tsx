import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Empty, PageHead, Pager, SourceIcon } from '@/components/ui';
import { KIND_TEXT, timelineEvents, type TimelineEvent } from '@/db/timeline';
import { useQuery, useStore } from '@/lib/store';

const DAYS_PER_PAGE = 20;
const PLATFORMS = [
  { key: '', label: 'All' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'phone', label: 'Added here' },
];

const dayLabel = (d: string) =>
  new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
const monthLabel = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export function Timeline() {
  const { db } = useStore();
  const [whoAdded, setWhoAdded] = useState<'mine' | 'all'>('mine');
  const [platform, setPlatform] = useState('');
  const [month, setMonth] = useState('');
  const [hideArchived, setHideArchived] = useState(true);
  const [page, setPage] = useState(0);
  const events = useQuery(() => timelineEvents(db), []);

  const filtered = useMemo(
    () =>
      (events ?? []).filter(
        (e) =>
          (whoAdded === 'all' || KIND_TEXT[e.kind].mine) &&
          (!platform || KIND_TEXT[e.kind].source === platform) &&
          (!hideArchived || e.status !== 'archived'),
      ),
    [events, whoAdded, platform, hideArchived],
  );
  const months = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of filtered) m.set(e.day.slice(0, 7), (m.get(e.day.slice(0, 7)) ?? 0) + 1);
    return [...m];
  }, [filtered]);
  const days = useMemo(() => {
    const m = new Map<string, TimelineEvent[]>();
    for (const e of filtered) if (!month || e.day.startsWith(month)) m.set(e.day.slice(0, 10), [...(m.get(e.day.slice(0, 10)) ?? []), e]);
    return [...m];
  }, [filtered, month]);

  if (!events) return null;
  const today = new Date();
  const since = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n).toISOString().slice(0, 10);
  const mine = events.filter((e) => KIND_TEXT[e.kind].mine && e.status !== 'archived');
  const last30 = mine.filter((e) => e.day >= since(30)).length;
  const thisYear = mine.filter((e) => e.day.startsWith(String(today.getFullYear()))).length;
  const pg = Math.min(page, Math.max(0, Math.ceil(days.length / DAYS_PER_PAGE) - 1));
  const reset = <T,>(fn: (v: T) => void) => (v: T) => {
    setPage(0);
    fn(v);
  };

  return (
    <div className="page timeline-page">
      <PageHead
        title="🗓 Timeline"
        sub={`Who you added, day by day. Last 30 days: ${last30.toLocaleString()} · This year: ${thisYear.toLocaleString()}`}
      />

      <div className="row-gap">
        <div className="chips" role="radiogroup" aria-label="Who">
          {(
            [
              ['mine', 'You added'],
              ['all', 'Also who followed you'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={whoAdded === k} className={`chip${whoAdded === k ? ' active' : ''}`} onClick={() => reset(setWhoAdded)(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="chips" role="radiogroup" aria-label="Platform">
          {PLATFORMS.map((p) => (
            <button key={p.key} type="button" role="radio" aria-checked={platform === p.key} className={`chip${platform === p.key ? ' active' : ''}`} onClick={() => reset(setPlatform)(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="row-gap">
        <select className="input" value={month} onChange={(e) => reset(setMonth)(e.target.value)} aria-label="Month">
          <option value="">All months</option>
          {months.map(([m, n]) => (
            <option key={m} value={m}>
              {monthLabel(m)} ({n})
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={hideArchived} onChange={(e) => reset(setHideArchived)(e.target.checked)} />
          Hide archived
        </label>
      </div>

      {days.length === 0 ? (
        <Empty>
          Nothing here yet. Dates come from your Instagram, LinkedIn and Facebook exports. Import them on the <Link to="/sync">Import page</Link> (already imported?
          Import them again to pick up the dates).
        </Empty>
      ) : (
        <>
          {days.slice(pg * DAYS_PER_PAGE, (pg + 1) * DAYS_PER_PAGE).map(([day, list]) => (
            <section key={day}>
              <h2 className="section-title">
                {dayLabel(day)} · {list.length}
              </h2>
              <ul className="list card">
                {list.map((e) => (
                  <li key={`${e.kind}:${e.person_id}`} className={`person-row${e.status === 'archived' ? ' dim' : ''}`}>
                    <Link to={`/person/${e.person_id}`} className="person-link">
                      <Avatar name={e.name} photo={e.photo} size={32} />
                      <span className="person-text">
                        <span className="person-name">{e.name}</span>
                        <span className="person-sub">{KIND_TEXT[e.kind].verb}</span>
                      </span>
                    </Link>
                    <div className="person-right">
                      <SourceIcon source={KIND_TEXT[e.kind].source} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <Pager page={pg} pageSize={DAYS_PER_PAGE} count={days.length} onChange={setPage} />
        </>
      )}
    </div>
  );
}
