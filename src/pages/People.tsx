import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatBirthday, formatDate } from '@/lib/dates';
import { Link, useLocation } from 'react-router';
import { Avatar, ContactButton, Chips, Empty, LabelMenu, Modal, PageHead, Pager, PhoneNumber, PhotoIndicator, EditableScore, ScoreBadge, SOURCE_ORDER, SourceIcon, TagChip } from '@/components/ui';
import { allTags, getPerson, listPeople, updatePerson, type PersonListRow, type PersonStatus } from '@/db/people';
import { CIRCLES, circleInfo, SOURCE_LABELS, type Circle } from '@/lib/constants';
import { describeScoreInfo } from '@/lib/ranking';
import { inferCircle } from '@/lib/relationship';
import { loadScores, setScoreByHand } from '@/db/ranking';
import { nameReviewList } from '@/db/names';
import { photoStatus } from '@/db/photos';
import { listDuplicates, mergePeople, richness } from '@/db/merge';
import { MergeForm, PersonMini } from './Duplicates';
import { allCities, deletePeople, getSetting, setArchived, setCity, setSetting, setTags, unlinkedPeople } from '@/db/people';
import { looksLikeOrganization } from '@/lib/orgs';
import { useQuery, useStore } from '@/lib/store';
import { EditControls } from '@/components/EditControls';

type Filter = 'all' | 'reviewed' | 'todo' | 'archived';
const FILTER_STATUS: Record<Filter, PersonStatus[]> = {
  all: ['new', 'backlog', 'reviewed'],
  reviewed: ['reviewed'],
  todo: ['new', 'backlog'],
  archived: ['archived'],
};
type SortKey = 'name' | ColumnKey;
type SortDir = 'asc' | 'desc';
/** Numbers and dates read best biggest/newest first; text A–Z. */
const DEFAULT_DIR: Partial<Record<SortKey, SortDir>> = { score: 'desc', created: 'desc', last_contacted: 'desc', sources: 'desc' };

/** Optional table columns, in display order. Person is always first. */
const COLUMN_ORDER = ['type', 'tags', 'score', 'sources', 'phone', 'email', 'company', 'city', 'how_met', 'birthday', 'last_contacted', 'created'] as const;
type ColumnKey = (typeof COLUMN_ORDER)[number];
const DEFAULT_COLUMNS: ColumnKey[] = ['type', 'tags', 'score', 'sources', 'city'];
type Column = {
  label: string;
  title?: string;
  mobileLabel?: string;
  width: string;
  min: number;
  render: (r: Row) => ReactNode;
  /** What to sort by (null/empty sorts last). Omit for columns that can't be sorted. */
  sortValue?: (r: Row) => string | number | null;
};
type CircleFilter = 'any' | Circle | 'unset' | 'org';

const PAGE = 50;
/** Contact icons the phone layout shows until you pick your own. */
const DEFAULT_MOBILE_ICONS = ['phone', 'instagram', 'linkedin', 'facebook'];

/** The links a phone row offers, in the order you chose: a phone number always means "call". */
function contactLinks(r: PersonListRow, icons: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const s of icons) {
    const href = s === 'phone' ? (r.phone ? `tel:${r.phone.replace(/[^\d+]/g, '')}` : null) : r.links[s];
    if (href) out.push([s, href]);
  }
  return out;
}

type Row = PersonListRow & { circleShown: Circle | null; guessed: boolean; score: number; guess: boolean; why: string; activity: number };

/** How each sortable column sorts. Kept outside the component so the list can sort before columns render. */
const columnSort: Partial<Record<ColumnKey, (r: Row) => string | number | null>> = {
  type: (r) => circleInfo(r.circleShown)?.label ?? null,
  tags: (r) => (r.tags.length ? r.tags.join(', ').toLowerCase() : null),
  score: (r) => r.score,
  sources: (r) => r.sources.length,
  phone: (r) => r.phone,
  email: (r) => r.email?.toLowerCase() ?? null,
  company: (r) => r.company?.toLowerCase() ?? null,
  city: (r) => r.city?.toLowerCase() ?? null,
  how_met: (r) => r.how_met?.toLowerCase() ?? null,
  birthday: (r) => (r.birthday ? r.birthday.slice(-5) : null),
  last_contacted: (r) => r.last_contacted,
  created: (r) => r.created_at,
};

function SortHeader({ label, title, k, sortKey, sortDir, onSort }: { label: string; title?: string; k: SortKey; sortKey: SortKey; sortDir: SortDir; onSort: (k: SortKey) => void }) {
  const active = k === sortKey;
  return (
    <span role="columnheader" aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} title={title}>
      <button type="button" className={`sort-head${active ? ' active' : ''}`} onClick={() => onSort(k)}>
        {label}
        <span aria-hidden className="sort-arrow">{active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </span>
  );
}

/** The "+" in a Tags cell: pick a tag you've used before, or type a new one to create it. */
function TagAdder({ person, allTags, onAdd }: { person: PersonListRow; allTags: string[]; onAdd: (tag: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, innerWidth - 246)) });
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    // Pinned to the screen (the table scrolls sideways, which would clip it), so follow the + on scroll.
    const hide = () => place();
    addEventListener('mousedown', close);
    addEventListener('scroll', hide, true);
    return () => {
      removeEventListener('mousedown', close);
      removeEventListener('scroll', hide, true);
    };
  }, [open]);
  const have = new Set(person.tags.map((t) => t.toLowerCase()));
  const query = q.trim();
  const options = allTags.filter((t) => !have.has(t.toLowerCase()) && t.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  const exists = allTags.some((t) => t.toLowerCase() === query.toLowerCase()) || have.has(query.toLowerCase());
  const add = (t: string) => {
    onAdd(t);
    setQ('');
    setOpen(false);
  };
  return (
    <span className="tag-adder" ref={box}>
      <button
        type="button"
        className="tag-plus"
        ref={btn}
        onClick={() => {
          place();
          setOpen((o) => !o);
        }} aria-label={`Add a tag to ${person.name}`} title="Add a tag">
        +
      </button>
      {open && (
        <span className="tag-pop card" style={pos ?? undefined} role="dialog" aria-label={`Tags for ${person.name}`}>
          <input
            className="input"
            autoFocus
            placeholder="Search or create a tag…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter' && query) {
                e.preventDefault();
                add(options.find((o) => o.toLowerCase() === query.toLowerCase()) ?? query);
              }
            }}
          />
          {options.map((t) => (
            <button key={t} type="button" className="tag-option" onClick={() => add(t)}>
              <TagChip tag={t} />
            </button>
          ))}
          {query && !exists && (
            <button type="button" className="tag-option create" onClick={() => add(query)}>
              + Create “{query}”
            </button>
          )}
          {!options.length && !query && <span className="small muted">Type a name to create your first tag.</span>}
        </span>
      )}
    </span>
  );
}

/** What the list looked like, so Back from a profile lands on the same page, filters and scroll. */
type View = { search: string; filter: Filter; tag: string; circle: CircleFilter; sortKey: SortKey; sortDir: SortDir; platform: string; city: string; page: number; scrollY: number };

/** Saved per history entry (location.key): Back restores it, clicking the People tab starts fresh. */
function readView(key: string): Partial<View> {
  try {
    return JSON.parse(sessionStorage.getItem(`people-view:${key}`) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function writeView(key: string, v: Partial<View>) {
  try {
    sessionStorage.setItem(`people-view:${key}`, JSON.stringify({ ...readView(key), ...v }));
  } catch {
    // Private mode or storage full: Back just won't remember.
  }
}

export function People() {
  const { db, bump, editing } = useStore();
  const { key: viewKey } = useLocation();
  const [saved] = useState(() => readView(viewKey));
  const [search, setSearch] = useState(saved.search ?? '');
  const [filter, setFilter] = useState<Filter>(saved.filter ?? 'all');
  const [tag, setTag] = useState(saved.tag ?? '');
  const [circle, setCircle] = useState<CircleFilter>(saved.circle ?? 'any');
  const [sortKey, setSortKey] = useState<SortKey>(saved.sortKey ?? 'score');
  const [sortDir, setSortDir] = useState<SortDir>(saved.sortDir ?? 'desc');
  const [platform, setPlatform] = useState(saved.platform ?? '');
  const [city, setCityFilter] = useState(saved.city ?? '');
  const sortBy = (k: SortKey) => {
    setPage(0);
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir(DEFAULT_DIR[k] ?? 'asc');
    }
  };
  const [page, setPage] = useState(saved.page ?? 0);
  useEffect(() => writeView(viewKey, { search, filter, tag, circle, sortKey, sortDir, platform, city, page }), [viewKey, search, filter, tag, circle, sortKey, sortDir, platform, city, page]);
  // Layout effect so the listener is gone before the next page scrolls to the top.
  useLayoutEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => writeView(viewKey, { scrollY: window.scrollY }));
    };
    addEventListener('scroll', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener('scroll', onScroll);
    };
  }, [viewKey]);
  const [selecting, setSelecting] = useState(false);
  // Drag one row onto another to merge them (on a phone: hold, then drag).
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropId, setDropId] = useState<number | null>(null);
  const [mergePair, setMergePair] = useState<{ keep: Row; drop: Row } | null>(null);
  // On a phone: press and hold a person, then drag onto another to merge them.
  const mobileList = useRef<HTMLUListElement>(null);
  const [touchGhost, setTouchGhost] = useState<{ x: number; y: number; name: string } | null>(null);
  const [merging, setMerging] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<{ el: HTMLElement; row: Row } | null>(null);

  const people = useQuery(async () => {
    const list = await listPeople(db, { status: FILTER_STATUS[filter], search, tag: tag || undefined });
    return { list, scores: await loadScores(db, list) };
  }, [filter, search, tag]);
  const tags = useQuery(() => allTags(db), []);
  const cities = useQuery(() => allCities(db), []);
  const photoInfo = useQuery(() => photoStatus(db), []);
  const unlinked = useQuery(() => unlinkedPeople(db), []);
  // One column per source you've imported from, in a fixed order, so icons line up row to row.
  const sourceCols = useQuery(async () => {
    const used = new Set((await db.getAllAsync<{ source: string }>('SELECT DISTINCT source FROM sources')).map((r) => r.source));
    return [...SOURCE_ORDER.filter((s) => used.has(s)), ...[...used].filter((s) => !SOURCE_ORDER.includes(s))];
  }, []) ?? [];

  // Which columns to show (Person is always shown). Saved with your data so it sticks.
  const savedCols = useQuery(async () => {
    const v = await getSetting(db, 'people_columns');
    try {
      return v ? (JSON.parse(v) as ColumnKey[]) : null;
    } catch {
      return null;
    }
  }, []);
  // Which contact icons the phone layout shows, in SOURCE_ORDER. Saved with your data.
  const savedIcons = useQuery(async () => {
    const v = await getSetting(db, 'people_mobile_icons');
    try {
      return v ? (JSON.parse(v) as string[]) : null;
    } catch {
      return null;
    }
  }, []);
  const [mobileIcons, setMobileIcons] = useState<string[] | null>(null);
  const iconKeys = mobileIcons ?? savedIcons ?? DEFAULT_MOBILE_ICONS;
  const toggleIcon = async (s: string) => {
    const next = iconKeys.includes(s) ? iconKeys.filter((k) => k !== s) : SOURCE_ORDER.filter((k) => k === s || iconKeys.includes(k));
    setMobileIcons(next);
    await setSetting(db, 'people_mobile_icons', JSON.stringify(next));
  };
  const [showFilters, setShowFilters] = useState(false);
  const [visibleCols, setVisibleCols] = useState<ColumnKey[] | null>(null);
  const colKeys = visibleCols ?? savedCols ?? DEFAULT_COLUMNS;
  const toggleCol = async (key: ColumnKey) => {
    const next = colKeys.includes(key) ? colKeys.filter((k) => k !== key) : COLUMN_ORDER.filter((k) => k === key || colKeys.includes(k));
    setVisibleCols(next);
    await setSetting(db, 'people_columns', JSON.stringify(next));
  };

  const columns: Record<ColumnKey, Column> = {
    type: {
      label: 'Type',
      width: '120px',
      min: 110,
      sortValue: (r) => circleInfo(r.circleShown)?.label ?? null,
      render: (r) => {
        const c = circleInfo(r.circleShown);
        return (
          <button
            type="button"
            className={`pill pill-sm${c ? '' : ' unset'}${r.guessed ? ' guessed' : ''}`}
            style={c ? { background: c.color } : undefined}
            title={r.guessed ? `Guessed from ${r.sources.map((x) => SOURCE_LABELS[x] ?? x).join(', ')}. Click to set.` : 'Click to change'}
            onClick={(e) => setMenu({ el: e.currentTarget, row: r })}
          >
            {c ? c.label : '+ Type'}
          </button>
        );
      },
    },
    tags: {
      label: 'Tags',
      width: 'minmax(140px, 2fr)',
      min: 140,
      sortValue: (r) => (r.tags.length ? r.tags.join(', ').toLowerCase() : null),
      render: (r) => (
        <span className="pt-tags">
          {r.tags.map((t) => (
            <button key={t} type="button" className="tag-btn" onClick={() => resetPaging(setTag)(t)} title={`Show everyone tagged ${t}`}>
              <TagChip tag={t} />
            </button>
          ))}
          <TagAdder
            person={r}
            allTags={(tags ?? []).map((t) => t.tag)}
            onAdd={async (t) => {
              await setTags(db, r.id, [...r.tags, t]);
              bump();
            }}
          />
        </span>
      ),
    },
    score: {
      label: 'Closeness',
      title: '0–10. Faded = guessed from how much you talk. Click a score to set it yourself, or play Rank.',
      width: '150px',
      min: 110,
      render: (r) => (
        <EditableScore
          score={r.score}
          title={r.why}
          guess={r.guess}
          onSave={async (n) => {
            await setScoreByHand(db, r.id, n, r.activity);
            bump();
          }}
        />
      ),
      sortValue: (r) => r.score,
    },
    sources: {
      label: 'Connected on',
      sortValue: (r) => r.sources.length,
      width: `${Math.max(sourceCols.length, 1) * 28 + 8}px`,
      min: Math.max(sourceCols.length, 1) * 28 + 8,
      render: (r) => (
        <span className="source-grid" style={{ gridTemplateColumns: `repeat(${Math.max(sourceCols.length, 1)}, 26px)` }}>
          {sourceCols.map((x) => (
            <SourceIcon key={x} source={x} href={r.links[x]} missing={!r.sources.includes(x)} />
          ))}
        </span>
      ),
    },
    phone: { label: 'Phone', mobileLabel: '📞', width: '150px', min: 130, sortValue: (r) => r.phone, render: (r) => (r.phone ? <PhoneNumber phone={r.phone} name={r.name} /> : null) },
    email: { label: 'Email', mobileLabel: '✉️', width: 'minmax(160px, 1.5fr)', min: 160, sortValue: (r) => r.email?.toLowerCase() ?? null, render: (r) => (r.email ? <a href={`mailto:${r.email}`}>{r.email}</a> : null) },
    company: { label: 'Company', mobileLabel: '🏢', width: 'minmax(120px, 1.2fr)', min: 120, sortValue: (r) => r.company?.toLowerCase() ?? null, render: (r) => r.company || null },
    city: { label: 'Location', mobileLabel: '📍', width: '150px', min: 130, sortValue: (r) => r.city?.toLowerCase() ?? null, render: (r) => r.city || null },
    how_met: { label: 'How you met', mobileLabel: '🤝', width: 'minmax(140px, 1.5fr)', min: 140, sortValue: (r) => r.how_met?.toLowerCase() ?? null, render: (r) => r.how_met || null },
    birthday: { label: 'Birthday', mobileLabel: '🎂', width: '110px', min: 100, sortValue: (r) => (r.birthday ? r.birthday.slice(-5) : null), render: (r) => (r.birthday ? formatBirthday(r.birthday) : null) },
    last_contacted: { label: 'Last talked', mobileLabel: '💬', width: '120px', min: 110, sortValue: (r) => r.last_contacted, render: (r) => (r.last_contacted ? formatDate(r.last_contacted) : null) },
    created: { label: 'Added', mobileLabel: 'Added', width: '120px', min: 110, sortValue: (r) => r.created_at, render: (r) => formatDate(r.created_at.slice(0, 10)) },
  };
  const shownCols = COLUMN_ORDER.filter((k) => colKeys.includes(k)).map((k) => ({ key: k, ...columns[k] }));
  const gridCols = ['44px', 'minmax(200px, 2.2fr)', ...shownCols.map((c) => c.width), ...(editing ? ['44px'] : [])].join(' ');
  const tableMinWidth = 44 + 200 + shownCols.reduce((n, c) => n + c.min + 12, 0) + (editing ? 56 : 0);
  const filtersOn = filter !== 'all' || !!tag || !!city || circle !== 'any' || !!platform;
  const needNames = useQuery(async () => (await nameReviewList(db)).length, []) ?? 0;
  const dupes = useQuery(async () => (await listDuplicates(db)).filter((p) => p.strong).length, []) ?? 0;

  const rows = useMemo(() => {
    if (!people) return null;
    const out: Row[] = people.list.map((p) => {
      const guess = inferCircle(p.sources, !!p.stage);
      const s = people.scores.get(p.id)!;
      return { ...p, circleShown: p.circle ?? guess, guessed: !p.circle && !!guess, score: s.score, guess: !s.placed, why: describeScoreInfo(s), activity: s.activity };
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
    const list = platform ? filtered.filter((r) => r.sources.includes(platform)) : filtered;
    // Sort by the chosen column; empty values always go last; ties fall back to name.
    const value = sortKey === 'name' ? (r: Row) => r.name.toLowerCase() : columnSort[sortKey];
    if (value) {
      const sign = sortDir === 'asc' ? 1 : -1;
      list.sort((a, b) => {
        const x = value(a);
        const y = value(b);
        const xe = x === null || x === '';
        const ye = y === null || y === '';
        if (xe !== ye) return xe ? 1 : -1;
        const c = xe ? 0 : typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return sign * c || a.name.localeCompare(b.name);
      });
    }
    return list;
  }, [people, circle, sortKey, sortDir, city, platform]);

  // Phone drag-to-merge. Browsers don't do HTML drag-and-drop with a finger, so this is done by hand:
  // hold a row still for a moment (moving first is a normal scroll), then drag it onto someone else.
  // Native listeners because the page must not scroll while dragging (React's touch listeners are passive).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const ul = mobileList.current;
    if (!ul || selecting) return;
    const HOLD_MS = 450;
    const SLOP = 10;
    let timer = 0;
    let frame = 0;
    let start: { x: number; y: number } | null = null;
    let from: Row | null = null;
    let over: number | null = null;
    let lastY = 0;
    let justDragged = false;
    const idAt = (x: number, y: number) => {
      const li = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.pm-row[data-person-id]');
      return li && ul.contains(li) ? Number(li.dataset.personId) : null;
    };
    const autoScroll = () => {
      if (!from) return;
      const edge = 70;
      const h = window.innerHeight;
      const dy = lastY < edge ? -(edge - lastY) / 4 : lastY > h - edge ? (lastY - (h - edge)) / 4 : 0;
      if (dy) window.scrollBy(0, dy);
      frame = requestAnimationFrame(autoScroll);
    };
    const reset = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      start = null;
      from = null;
      over = null;
      setDragId(null);
      setDropId(null);
      setTouchGhost(null);
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return reset();
      const t = e.touches[0];
      // The contact buttons on the right are for calling/texting, not dragging.
      if ((e.target as HTMLElement).closest('.pm-icons')) return;
      const id = idAt(t.clientX, t.clientY);
      const row = rowsRef.current?.find((r) => r.id === id);
      if (!row) return;
      start = { x: t.clientX, y: t.clientY };
      lastY = t.clientY;
      timer = window.setTimeout(() => {
        from = row;
        navigator.vibrate?.(30);
        setDragId(row.id);
        setTouchGhost({ x: start!.x, y: start!.y, name: row.name });
        frame = requestAnimationFrame(autoScroll);
      }, HOLD_MS);
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      if (!from) {
        // Moved before the hold finished: it's a scroll, not a drag.
        if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > SLOP) {
          clearTimeout(timer);
          start = null;
        }
        return;
      }
      e.preventDefault();
      lastY = t.clientY;
      setTouchGhost({ x: t.clientX, y: t.clientY, name: from.name });
      const id = idAt(t.clientX, t.clientY);
      over = id !== null && id !== from.id ? id : null;
      setDropId(over);
    };
    const onEnd = (e: TouchEvent) => {
      const dragged = from;
      const target = over;
      if (dragged) {
        e.preventDefault(); // no tap on the row's link after a drag
        justDragged = true;
        setTimeout(() => (justDragged = false), 400);
      }
      reset();
      if (dragged && target !== null) {
        const keep = rowsRef.current?.find((r) => r.id === target);
        if (keep) setMergePair({ keep, drop: dragged });
      }
    };
    const onClick = (e: MouseEvent) => {
      if (justDragged) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onMenu = (e: Event) => {
      if (start || from) e.preventDefault(); // Android's long-press menu
    };
    ul.addEventListener('touchstart', onStart, { passive: true });
    ul.addEventListener('touchmove', onMove, { passive: false });
    ul.addEventListener('touchend', onEnd, { passive: false });
    ul.addEventListener('touchcancel', reset);
    ul.addEventListener('click', onClick, true);
    ul.addEventListener('contextmenu', onMenu);
    return () => {
      reset();
      ul.removeEventListener('touchstart', onStart);
      ul.removeEventListener('touchmove', onMove);
      ul.removeEventListener('touchend', onEnd);
      ul.removeEventListener('touchcancel', reset);
      ul.removeEventListener('click', onClick, true);
      ul.removeEventListener('contextmenu', onMenu);
    };
  }, [selecting, !!rows?.length]);

  // The list loads after the first render, so scroll back once the rows are on screen.
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !rows) return;
    restored.current = true;
    if (saved.scrollY) window.scrollTo(0, saved.scrollY);
  }, [rows, saved]);

  const bulkCity = async () => {
    const c = prompt(`City for ${selected.size.toLocaleString()} ${selected.size === 1 ? 'person' : 'people'} (e.g. Los Angeles, CA). Leave blank to clear.`, city && city !== '__none' ? city : '');
    if (c === null) return;
    await setCity(db, [...selected], c);
    setSelected(new Set());
    bump();
  };

  /** Edit mode only, so it can still be undone with Discard until you press Save. Always asks first. */
  const removePeople = async (ids: number[], label: string) => {
    if (!ids.length || !confirm(`Delete ${label}? They'll stay in the Recycle bin for 30 days in case you change your mind.`)) return;
    await deletePeople(db, ids);
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
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
    <div className="page page-wide people-page">
      <PageHead
        title="People"
        sub={
          rows ? (
            <>
              {rows.length.toLocaleString()} {rows.length === 1 ? 'person' : 'people'}
              {photoInfo && (
                <>
                  <br />
                  <PhotoIndicator withPhoto={photoInfo.withPhoto} total={photoInfo.total} updatedAt={photoInfo.updatedAt} fetchLink={false} />
                </>
              )}
            </>
          ) : undefined
        }
      >
        <Link className="btn secondary" to="/photos?fetch=1" title="Get profile pictures from Gravatar and Google, then copy the rest from Instagram/LinkedIn">
          📸 Fetch pictures
        </Link>
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
        <button type="button" className={`btn ${selecting ? 'primary' : 'secondary'}`} onClick={() => { setSelecting((v) => !v); setSelected(new Set()); }}>
          {selecting ? 'Done selecting' : '☑ Select'}
        </button>
        <Link className="btn primary" to="/person/new">
          + Add person
        </Link>
      </PageHead>
      <EditControls />
      {unlinked && unlinked.length > 0 && (
        <section className="card pad row-gap chat-only">
          <span className="grow small">
            <strong>{unlinked.length.toLocaleString()} people have no contact or profile link</strong>: no phone contact, Instagram, LinkedIn,
            Facebook or Discord account, phone number or email. Most came from chats in older versions; chats no longer add people.
          </span>
          <button
            type="button"
            className="btn danger small"
            onClick={async () => {
              if (!confirm(`Remove ${unlinked.length.toLocaleString()} people with no contact or profile link, including any notes, tags or rankings on them? They'll stay in the Recycle bin for 30 days.`)) return;
              await deletePeople(db, unlinked);
              bump();
            }}
          >
            Remove them
          </button>
        </section>
      )}
      <div className="toolbar">
        <input
          type="search"
          className="input"
          placeholder="Search names, tags, @handles, companies, notes…"
          value={search}
          onChange={(e) => resetPaging(setSearch)(e.target.value)}
          aria-label="Search people"
        />
        <div className="mobile-only filter-toggle">
          <button type="button" className={`btn ${filtersOn ? 'primary' : 'secondary'} small`} aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
            ☰ Filters &amp; sort{filtersOn ? ' (on)' : ''}
          </button>
          <details className="col-menu">
            <summary className="btn secondary small">⚙︎ Icons</summary>
            <div className="col-menu-pop card" role="group" aria-label="Contact icons to show">
              <span className="small muted">Show these icons</span>
              {SOURCE_ORDER.map((s) => (
                <label key={s} className="check">
                  <input type="checkbox" checked={iconKeys.includes(s)} onChange={() => toggleIcon(s)} />
                  {s === 'phone' ? 'Phone (tap to call)' : (SOURCE_LABELS[s] ?? s)}
                </label>
              ))}
            </div>
          </details>
        </div>
        <div className={`filter-row${showFilters ? ' open' : ''}`}>
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
            <details className="col-menu desktop-only">
              <summary className="btn secondary small">⚙︎ Columns</summary>
              <div className="col-menu-pop card" role="group" aria-label="Columns to show">
                <span className="small muted">Show columns</span>
                {COLUMN_ORDER.map((k) => (
                  <label key={k} className="check">
                    <input type="checkbox" checked={colKeys.includes(k)} onChange={() => toggleCol(k)} />
                    {columns[k].label}
                  </label>
                ))}
                <button type="button" className="link-btn small" onClick={() => { setVisibleCols(DEFAULT_COLUMNS); setSetting(db, 'people_columns', null); }}>
                  Reset to default
                </button>
              </div>
            </details>
            <select className="input" value={platform} onChange={(e) => resetPaging(setPlatform)(e.target.value)} aria-label="Platform">
              <option value="">All platforms</option>
              {sourceCols.map((x) => (
                <option key={x} value={x}>
                  {SOURCE_LABELS[x] ?? x}
                </option>
              ))}
            </select>
            <span className="sort-picker">
              <select
                className="input"
                value={sortKey}
                onChange={(e) => {
                  const k = e.target.value as SortKey;
                  setPage(0);
                  setSortKey(k);
                  setSortDir(DEFAULT_DIR[k] ?? 'asc');
                }}
                aria-label="Sort"
              >
                <option value="name">Sort: Name</option>
                {COLUMN_ORDER.filter((k) => columnSort[k]).map((k) => (
                  <option key={k} value={k}>
                    Sort: {columns[k].label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn secondary small" onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))} aria-label={sortDir === 'asc' ? 'Ascending, click to reverse' : 'Descending, click to reverse'} title="Reverse the order">
                {sortDir === 'asc' ? '↑' : '↓'}
              </button>
            </span>
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
          {editing && (
            <button
              type="button"
              className="btn danger small"
              disabled={!selected.size}
              onClick={() => removePeople([...selected], `${selected.size.toLocaleString()} ${selected.size === 1 ? 'person' : 'people'}`)}
            >
              🗑 Delete {selected.size || ''}
            </button>
          )}
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="card people-table" role="table" aria-label="People">
          <div className="pt-inner" style={{ ['--pt-cols' as string]: gridCols, ['--pt-min' as string]: `${tableMinWidth}px` }}>
            <div className="pt-row pt-head" role="row">
              <span role="columnheader" className="pt-num">#</span>
              <SortHeader label="Person" k="name" sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
              {shownCols.map((c) =>
                c.sortValue ? (
                  <SortHeader key={c.key} label={c.label} title={c.title} k={c.key} sortKey={sortKey} sortDir={sortDir} onSort={sortBy} />
                ) : (
                  <span key={c.key} role="columnheader" title={c.title}>
                    {c.label}
                  </span>
                ),
              )}
              {editing && <span role="columnheader" aria-label="Delete" />}
            </div>
            {rows.slice(pg * PAGE, (pg + 1) * PAGE).map((r, j) => {
              const i = pg * PAGE + j;
              const person = (
                <>
                  <Avatar name={r.name} photo={r.photo} size={36} />
                  <span className="person-name">
                    {r.name}
                    {r.nickname && <span className="nickname"> ({r.nickname})</span>}
                  </span>
                </>
              );
              return (
                <div
                  key={r.id}
                  className={`pt-row${r.status === 'archived' ? ' dim' : ''}${dragId === r.id ? ' dragging' : ''}${dropId === r.id ? ' drop-target' : ''}`}
                  role="row"
                  draggable={!selecting}
                  title={selecting ? undefined : 'Drag onto another person to merge them'}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-crm-person', String(r.id));
                    e.dataTransfer.effectAllowed = 'move';
                    setDragId(r.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropId(null);
                  }}
                  onDragOver={(e) => {
                    if (dragId === null || dragId === r.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dropId !== r.id) setDropId(r.id);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropId((d) => (d === r.id ? null : d));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = rows.find((x) => x.id === Number(e.dataTransfer.getData('application/x-crm-person')));
                    setDragId(null);
                    setDropId(null);
                    if (from && from.id !== r.id) setMergePair({ keep: r, drop: from });
                  }}
                >
                  <span className="pt-num" role="cell">{i + 1}</span>
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
                      {person}
                    </label>
                  ) : (
                    <Link to={`/person/${r.id}`} className="pt-person" role="cell">
                      {person}
                    </Link>
                  )}
                  {shownCols.map((c) => {
                    const v = c.render(r);
                    return (
                      <span key={c.key} role="cell" className={`pt-cell pt-${c.key}${v === null ? ' is-empty' : ''}`} data-label={c.mobileLabel}>
                        {v}
                      </span>
                    );
                  })}
                  {editing && (
                    <span role="cell" className="pt-cell pt-delete">
                      <button type="button" className="btn ghost small icon-btn" title={`Delete ${r.name}`} aria-label={`Delete ${r.name}`} onClick={() => removePeople([r.id], r.name)}>
                        🗑
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {rows && rows.length > 1 && !selecting && <p className="small muted mobile-hint">Tip: hold a person, then drag them onto another to merge.</p>}
      {rows && rows.length > 0 && (
        <ul className="card people-mobile" aria-label="People" ref={mobileList}>
          {rows.slice(pg * PAGE, (pg + 1) * PAGE).map((r, j) => {
            const c = circleInfo(r.circleShown);
            const sub = [c?.label, ...r.tags].filter(Boolean).join(' · ');
            const who = (
              <>
                <span className="pm-num">{pg * PAGE + j + 1}</span>
                <Avatar name={r.name} photo={r.photo} size={44} />
                <span className="pm-text">
                  <span className="pm-name">
                    {r.name}
                    {r.nickname && <span className="nickname"> ({r.nickname})</span>}
                  </span>
                  {sub && <span className="pm-sub">{sub}</span>}
                </span>
                <span className="pm-score">
                  <ScoreBadge score={r.score} guess={r.guess} title={r.why} />
                </span>
              </>
            );
            return (
              <li
                key={r.id}
                data-person-id={r.id}
                className={`pm-row${r.status === 'archived' ? ' dim' : ''}${dragId === r.id ? ' dragging' : ''}${dropId === r.id ? ' drop-target' : ''}`}
              >
                {selecting ? (
                  <label className="pm-person">
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
                    {who}
                  </label>
                ) : (
                  <Link to={`/person/${r.id}`} className="pm-person">
                    {who}
                  </Link>
                )}
                <span className="pm-icons">
                  {contactLinks(r, iconKeys).map(([s, href]) => (
                    <ContactButton key={s} source={s} href={href} name={r.name} />
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {touchGhost && (
        <div className="touch-ghost" style={{ left: touchGhost.x, top: touchGhost.y }} aria-hidden>
          {touchGhost.name}
        </div>
      )}
      {rows && <Pager page={pg} pageSize={PAGE} count={rows.length} onChange={setPage} />}
      {rows && rows.length === 0 && <Empty>{search || tag || city || circle !== 'any' ? 'No matches.' : 'No one here yet.'}</Empty>}

      <Modal open={!!mergePair} title="Merge these two?" onClose={() => setMergePair(null)}>
        {mergePair && (
          <div className="stack">
            <p className="small muted">
              Everything from both is kept: blank details are filled in, notes are combined, and tags, chats, rankings and where they came from all move to one person.
            </p>
            <div className="dup-pair">
              <PersonMini p={mergePair.drop} />
              <span className="dup-and" aria-hidden>
                →
              </span>
              <PersonMini p={mergePair.keep} />
            </div>
            <MergeForm
              a={mergePair.keep}
              b={mergePair.drop}
              busy={merging}
              onMerge={async (name) => {
                setMerging(true);
                try {
                  // Keep whichever record has more on it; the name is your choice.
                  const [ka, kb] = [await getPerson(db, mergePair.keep.id), await getPerson(db, mergePair.drop.id)];
                  const keepFirst = !ka || !kb || (await richness(db, ka)) >= (await richness(db, kb));
                  const [keepId, dropId2] = keepFirst ? [mergePair.keep.id, mergePair.drop.id] : [mergePair.drop.id, mergePair.keep.id];
                  await mergePeople(db, keepId, dropId2, name);
                  setMergePair(null);
                  bump();
                } finally {
                  setMerging(false);
                }
              }}
              extra={
                <button type="button" className="btn ghost" onClick={() => setMergePair(null)}>
                  Cancel
                </button>
              }
            />
          </div>
        )}
      </Modal>

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

