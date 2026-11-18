import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Empty, PageHead, Pager, SourceIcon } from '@/components/ui';
import { firstConnected, GROUPS, iconFor, KIND_INFO, timelineEvents, type TimelineEvent, type TimelineGroup } from '@/db/timeline';
import { useQuery, useStore } from '@/lib/store';

const DAYS_PER_PAGE = 20;
const PLATFORMS = [
  { key: '', label: 'All apps' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'discord', label: 'Discord' },
  { key: 'phone', label: 'Contacts & in person' },
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
  const [group, setGroup] = useState<TimelineGroup | ''>('');
  const [platform, setPlatform] = useState('');
  const [month, setMonth] = useState('');
  const [hideArchived, setHideArchived] = useState(true);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [calMonth, setCalMonth] = useState<string | null>(null); // YYYY-MM
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const events = useQuery(() => timelineEvents(db), []);

  const filtered = useMemo(
    () =>
      (events ?? []).filter(
        (e) =>
          (!group || KIND_INFO[e.kind].group === group) &&
          (!platform || iconFor(e) === platform) &&
          (!hideArchived || e.status !== 'archived'),
      ),
    [events, group, platform, hideArchived],
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

  const byDay = useMemo(() => {
    const m = new Map<string, TimelineEvent[]>();
    for (const e of filtered) m.set(e.day.slice(0, 10), [...(m.get(e.day.slice(0, 10)) ?? []), e]);
    return m;
  }, [filtered]);

  if (!events) return null;
  const latestMonth = filtered[0]?.day.slice(0, 7) ?? new Date().toISOString().slice(0, 7);
  const shownMonth = calMonth ?? latestMonth;
  const shiftMonth = (delta: number) => {
    const [y, m] = shownMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setCalMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    setPickedDay(null);
  };
  const today = new Date();
  const since = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n).toISOString().slice(0, 10);
  // "New connections": people whose very first connection (any app, any direction) falls in the period.
  const firsts = [...firstConnected(events.filter((e) => e.status !== 'archived')).values()];
  const last30 = firsts.filter((d) => d >= since(30)).length;
  const thisYear = firsts.filter((d) => d.startsWith(String(today.getFullYear()))).length;
  const pg = Math.min(page, Math.max(0, Math.ceil(days.length / DAYS_PER_PAGE) - 1));
  const reset = <T,>(fn: (v: T) => void) => (v: T) => {
    setPage(0);
    fn(v);
  };

  return (
    <div className="page timeline-page">
      <PageHead
        title="🗓 Timeline"
        sub={`Every way you connected with people, day by day. New connections: ${last30.toLocaleString()} in the last 30 days · ${thisYear.toLocaleString()} this year`}
      />

      <div className="row-gap">
        <div className="chips" role="radiogroup" aria-label="How you connected">
          {[{ key: '' as const, label: 'Everything' }, ...GROUPS].map((g) => (
            <button key={g.key} type="button" role="radio" aria-checked={group === g.key} className={`chip${group === g.key ? ' active' : ''}`} onClick={() => reset(setGroup)(g.key)}>
              {g.label}
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
        <div className="chips" role="radiogroup" aria-label="View">
          {(
            [
              ['list', '☰ List'],
              ['calendar', '📅 Calendar'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={view === k} className={`chip${view === k ? ' active' : ''}`} onClick={() => setView(k)}>
              {label}
            </button>
          ))}
        </div>
        {view === 'list' && (
        <select className="input" value={month} onChange={(e) => reset(setMonth)(e.target.value)} aria-label="Month">
          <option value="">All months</option>
          {months.map(([m, n]) => (
            <option key={m} value={m}>
              {monthLabel(m)} ({n})
            </option>
          ))}
        </select>
        )}
        <label className="check">
          <input type="checkbox" checked={hideArchived} onChange={(e) => reset(setHideArchived)(e.target.checked)} />
          Hide archived
        </label>
      </div>

      {view === 'calendar' ? (
        <CalendarMonth
          month={shownMonth}
          byDay={byDay}
          picked={pickedDay}
          onPick={(d) => setPickedDay((p) => (p === d ? null : d))}
          onPrev={() => shiftMonth(-1)}
          onNext={() => shiftMonth(1)}
          onLatest={() => {
            setCalMonth(null);
            setPickedDay(null);
          }}
        />
      ) : days.length === 0 ? (
        <Empty>
          Nothing here yet. Dates come from your Instagram, LinkedIn, Facebook and Discord exports (follows, connections, friends, first messages and calls). Import them on the <Link to="/sync">Import page</Link>. Already imported? Import them again to pick up the dates.
        </Empty>
      ) : (
        <>
          {days.slice(pg * DAYS_PER_PAGE, (pg + 1) * DAYS_PER_PAGE).map(([day, list]) => (
            <DayList key={day} day={day} list={list} />
          ))}
          <Pager page={pg} pageSize={DAYS_PER_PAGE} count={days.length} onChange={setPage} />
        </>
      )}
    </div>
  );
}

function DayList({ day, list }: { day: string; list: TimelineEvent[] }) {
  return (
    <section>
      <h2 className="section-title">
        {dayLabel(day)} · {list.length}
      </h2>
      <ul className="list card">
        {list.map((e) => (
          <li key={`${e.kind}:${e.source}:${e.person_id}:${e.day}`} className={`person-row${e.status === 'archived' ? ' dim' : ''}`}>
            <Link to={`/person/${e.person_id}`} className="person-link">
              <Avatar name={e.name} photo={e.photo} size={32} />
              <span className="person-text">
                <span className="person-name">{e.name}</span>
                <span className="person-sub">{KIND_INFO[e.kind].verb(e)}</span>
              </span>
            </Link>
            <div className="person-right">
              <SourceIcon source={iconFor(e)} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' })); // Jan 1, 2023 was a Sunday
/** Shade: 0 none, 1 one person, 2 two–three, 3 four–nine, 4 ten or more. */
const level = (n: number) => (n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n < 10 ? 3 : 4);

/** A month grid: each day shows how many people you added, with their faces; click a day to list them. */
function CalendarMonth({ month, byDay, picked, onPick, onPrev, onNext, onLatest }: {
  month: string;
  byDay: Map<string, TimelineEvent[]>;
  picked: string | null;
  onPick: (day: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onLatest: () => void;
}) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysIn = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = [...Array(first.getDay()).fill(null)];
  for (let d = 1; d <= daysIn; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const total = cells.reduce((n, d) => n + (d ? byDay.get(d)?.length ?? 0 : 0), 0);
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const pickedList = picked ? byDay.get(picked) ?? [] : [];
  return (
    <>
      <section className="card pad cal">
        <div className="cal-head">
          <button type="button" className="btn ghost small" onClick={onPrev} aria-label="Previous month">
            ‹
          </button>
          <h2 className="cal-title">
            {monthLabel(month)} <span className="muted small">· {total.toLocaleString()} {total === 1 ? 'connection' : 'connections'}</span>
          </h2>
          <button type="button" className="btn ghost small" onClick={onNext} aria-label="Next month">
            ›
          </button>
          <button type="button" className="btn secondary small" onClick={onLatest}>
            Latest
          </button>
        </div>
        <div className="cal-grid" role="grid" aria-label={monthLabel(month)}>
          {WEEKDAYS.map((w) => (
            <span key={w} className="cal-wd" role="columnheader">
              {w}
            </span>
          ))}
          {cells.map((d, i) => {
            if (!d) return <span key={i} className="cal-cell blank" />;
            const list = byDay.get(d) ?? [];
            return (
              <button
                key={d}
                type="button"
                role="gridcell"
                className={`cal-cell lvl-${level(list.length)}${picked === d ? ' picked' : ''}${d === todayKey ? ' today' : ''}`}
                onClick={() => list.length && onPick(d)}
                disabled={!list.length}
                aria-label={`${dayLabel(d)}: ${list.length} ${list.length === 1 ? 'connection' : 'connections'}`}
                title={list.length ? list.slice(0, 8).map((e) => e.name).join(', ') + (list.length > 8 ? ` and ${list.length - 8} more` : '') : undefined}
              >
                <span className="cal-day">{Number(d.slice(8))}</span>
                {list.length > 0 && (
                  <>
                    <span className="cal-faces" aria-hidden>
                      {list.slice(0, 3).map((e) => (
                        <Avatar key={e.kind + e.source + e.person_id} name={e.name} photo={e.photo} size={20} />
                      ))}
                    </span>
                    <span className="cal-count">{list.length}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </section>
      {picked ? (
        <DayList day={picked} list={pickedList} />
      ) : (
        <p className="small muted">{total ? 'Click a day to see who you added.' : 'No one added this month. Use ‹ › or Latest.'}</p>
      )}
    </>
  );
}
