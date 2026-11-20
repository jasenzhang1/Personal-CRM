import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Person } from '@/db/people';
import { ReadOnlyError } from '@/db/browser';
import { useStore } from '@/lib/store';
import { appProfileUrl } from '@/lib/sourceLinks';

export function Avatar({ name, photo, size = 40 }: { name: string; photo?: string | null; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase())
    .join('');
  const [broken, setBroken] = useState<string | null>(null);
  if (photo && photo !== broken)
    return <img className="avatar" src={photo} alt="" loading="lazy" onError={() => setBroken(photo)} style={{ width: size, height: size }} />;
  const h = hue(name);
  return (
    <span
      className="avatar"
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${h} 55% 85%)`, color: `hsl(${h} 45% 28%)` }}
    >
      {initials || '?'}
    </span>
  );
}

function hue(s: string) {
  let h = 0;
  for (const ch of s.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** A colored tag label; the same tag always gets the same color. */
export function TagChip({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  const h = hue(tag);
  return (
    <span className="tag-chip" style={{ ['--h' as string]: h }}>
      {tag}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${tag}`}>
          ×
        </button>
      )}
    </span>
  );
}

/** Type a tag and press Enter (or comma). Suggests tags you've used before. */
export function TagInput({ value, onChange, suggestions }: { value: string[]; onChange: (tags: string[]) => void; suggestions: string[] }) {
  const [draft, setDraft] = useState('');
  const has = (t: string) => value.some((v) => v.toLowerCase() === t.toLowerCase());
  const add = (raw: string) => {
    const t = raw.replace(/,/g, '').trim();
    if (t && !has(t)) onChange([...value, suggestions.find((s) => s.toLowerCase() === t.toLowerCase()) ?? t]);
    setDraft('');
  };
  const unused = suggestions.filter((s) => !has(s));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value.length > 0 && (
        <div className="badges">
          {value.map((t) => <TagChip key={t} tag={t} onRemove={() => onChange(value.filter((v) => v !== t))} />)}
        </div>
      )}
      <div className="row-gap">
        <input
          className="input grow"
          list="tag-suggestions"
          value={draft}
          placeholder="Add a tag: school, club, hobby, company…"
          aria-label="Add a tag"
          onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => draft.trim() && add(draft)}
        />
        <button type="button" className="btn secondary" onClick={() => add(draft)} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      <datalist id="tag-suggestions">
        {unused.map((s) => <option key={s} value={s} />)}
      </datalist>
      {unused.length > 0 && (
        <div className="badges">
          <span className="small muted">Used before:</span>
          {unused.slice(0, 8).map((s) => (
            <button key={s} type="button" className="link-btn small" onClick={() => add(s)}>
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Beli-style 0–10 closeness score with a small bar. */
/** 0–10 closeness. `guess` = estimated from activity, not yet confirmed by you (shown faded). */
export function ScoreBadge({ score, rank, title, guess }: { score: number; rank?: number; title?: string; guess?: boolean }) {
  const level = score >= 7 ? 'high' : score >= 4 ? 'mid' : score > 0 ? 'low' : 'none';
  return (
    <span className={`score ${level}${guess && score > 0 ? ' guess' : ''}`} title={title} aria-label={`Closeness score ${score.toFixed(1)} out of 10${guess ? ', estimated' : ''}`}>
      <span className="score-num">{score.toFixed(1)}</span>
      <span className="score-bar">
        <span style={{ width: `${score * 10}%` }} />
      </span>
      {rank !== undefined && <span className="score-rank">#{rank}</span>}
    </span>
  );
}

/**
 * A score you can click to type a new one (0–10). Enter or clicking away saves, Escape cancels.
 * If Edit mode is off, the number you typed stays put with a button to turn it on and save.
 */
export function EditableScore({ score, title, guess, onSave }: { score: number; title?: string; guess?: boolean; onSave: (score: number) => void | Promise<void> }) {
  const { beginEdit } = useStore();
  const [draft, setDraft] = useState<string | null>(null);
  const [locked, setLocked] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const done = useRef(false);
  // Show what you typed until the reloaded score arrives.
  useEffect(() => setSaved(null), [score]);

  const save = async (n: number) => {
    try {
      await onSave(n);
      setLocked(null);
      setSaved(n);
    } catch (e) {
      if (!(e instanceof ReadOnlyError)) throw e;
      setLocked(n);
    }
  };
  const commit = async () => {
    if (done.current || draft === null) return;
    done.current = true;
    const n = Number(draft.replace(',', '.'));
    setDraft(null);
    if (draft.trim() !== '' && Number.isFinite(n) && Math.abs(n - score) >= 0.005) await save(Math.round(Math.max(0, Math.min(10, n)) * 100) / 100);
  };

  if (draft !== null)
    return (
      <input
        className="input score-input"
        type="number"
        inputMode="decimal"
        min={0}
        max={10}
        step={0.1}
        autoFocus
        draggable={false}
        value={draft}
        aria-label="Closeness score, 0 to 10"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onDragStart={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault(); // on a profile, Enter would otherwise submit the whole form
            commit();
          }
          if (e.key === 'Escape') {
            done.current = true;
            setDraft(null);
          }
        }}
      />
    );
  if (locked !== null)
    return (
      <span className="score-locked" role="alert">
        <ScoreBadge score={locked} />
        <button
          type="button"
          className="btn primary small"
          onClick={async () => {
            beginEdit();
            await save(locked);
          }}
        >
          Turn on Edit mode &amp; save
        </button>
        <button type="button" className="btn ghost small" onClick={() => setLocked(null)} aria-label="Cancel">
          ✕
        </button>
      </span>
    );
  const shown = saved ?? score;
  return (
    <button
      type="button"
      className="score-edit"
      title={`${title ? `${title}\n` : ''}Click to set the score yourself`}
      onClick={() => {
        done.current = false;
        setDraft(shown.toFixed(1));
      }}
    >
      <ScoreBadge score={shown} guess={guess && saved === null} />
    </button>
  );
}

export function Chips<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { key: K; label: string; color?: string }[];
  value: K | null | undefined;
  onChange: (k: K) => void;
  label?: string;
}) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            className={`chip${active ? ' active' : ''}`}
            style={active && o.color ? { background: o.color, borderColor: o.color } : undefined}
            onClick={() => onChange(o.key)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Closeness({ value, onChange, size = 22 }: { value: number; onChange?: (n: number) => void; size?: number }) {
  return (
    <span className="hearts" style={{ fontSize: size }} role={onChange ? 'radiogroup' : undefined} aria-label={`Closeness ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button key={n} type="button" className={n <= value ? 'on' : ''} onClick={() => onChange(n === value ? 0 : n)} aria-label={`${n}`}>
            ♥
          </button>
        ) : (
          <span key={n} className={n <= value ? 'on' : ''}>♥</span>
        ),
      )}
    </span>
  );
}

const SOURCE_STYLE: Record<string, [string, string]> = {
  phone: ['Contacts', '#4c9a2a'],
  google: ['Google', '#ea4335'],
  discord: ['Discord', '#5865f2'],
  linkedin: ['LinkedIn', '#0a66c2'],
  instagram: ['Instagram', '#c13584'],
  facebook: ['Facebook', '#1877f2'],
  sms: ['Text', '#34a853'],
  email: ['Email', '#5f6be0'],
};

/** Small brand marks, drawn here so nothing loads from other sites. */
const SOURCE_GLYPH: Record<string, ReactNode> = {
  instagram: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="17.3" cy="6.7" r="1.4" fill="currentColor" />
    </>
  ),
  linkedin: (
    <>
      <rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" />
      <rect x="6" y="10" width="2.8" height="8" fill="#fff" />
      <circle cx="7.4" cy="6.9" r="1.7" fill="#fff" />
      <path d="M11 10h2.7v1.2c.5-.8 1.5-1.4 2.8-1.4 2.3 0 3.1 1.4 3.1 3.6V18h-2.8v-4c0-1-.3-1.8-1.3-1.8-1.1 0-1.6.8-1.6 1.9V18H11z" fill="#fff" />
    </>
  ),
  facebook: (
    <>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="M13.2 21.9v-7h2.4l.4-2.8h-2.8v-1.8c0-.8.3-1.4 1.4-1.4H16V6.4c-.3 0-1.1-.1-2-.1-2 0-3.4 1.2-3.4 3.5v2.3H8.3v2.8h2.3v7z" fill="#fff" />
    </>
  ),
  discord: (
    <>
      <path d="M19.3 5.4A16 16 0 0 0 15.4 4.2l-.5 1a14.6 14.6 0 0 0-5.8 0l-.5-1a16 16 0 0 0-3.9 1.2C2.2 9.1 1.5 12.7 1.9 16.3a16 16 0 0 0 4.8 2.4l1-1.6c-.6-.2-1.1-.5-1.6-.8l.4-.3a11.4 11.4 0 0 0 10.1 0l.4.3c-.5.3-1 .6-1.6.8l1 1.6a16 16 0 0 0 4.8-2.4c.5-4.1-.6-7.7-1.9-10.9z" fill="currentColor" />
      <ellipse cx="8.8" cy="12.6" rx="1.6" ry="1.8" fill="#fff" />
      <ellipse cx="15.2" cy="12.6" rx="1.6" ry="1.8" fill="#fff" />
    </>
  ),
  google: (
    <path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3zM12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22zm-5.6-8a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9zM12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.7 9.4 5.9 12 5.9z" fill="currentColor" />
  ),
  phone: (
    <path
      d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"
      fill="currentColor"
    />
  ),
  sms: <path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-4.6 3.7A.9.9 0 0 1 2 21V5a2 2 0 0 1 2-2zm3 6.3a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zm5 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zm5 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z" fill="currentColor" />,
  email: (
    <>
      <rect x="2" y="4.5" width="20" height="15" rx="2.5" fill="currentColor" />
      <path d="M3.5 6.5l8.5 6.3 8.5-6.3" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
    </>
  ),
};

/**
 * A source as its brand icon: in color and clickable when we have a link to their profile there,
 * gray when that source only gave us a name (e.g. Facebook friends).
 */
/** The order icons appear in, so each source always sits in the same column. */
export const SOURCE_ORDER = ['phone', 'instagram', 'linkedin', 'facebook', 'discord', 'google'];

export function SourceIcon({ source, href, size = 18, missing }: { source: string; href?: string | null; size?: number; missing?: boolean }) {
  const [label, color] = SOURCE_STYLE[source] ?? [source, 'var(--muted)'];
  const glyph = SOURCE_GLYPH[source];
  const icon = glyph ? (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{glyph}</svg>
  ) : (
    <span className="source-icon-text">{label.slice(0, 2)}</span>
  );
  if (href) {
    const search = href.includes('facebook.com/search/');
    return (
      <a
        className="source-icon on"
        style={{ color }}
        href={href}
        target={href.startsWith('tel:') ? undefined : '_blank'}
        rel="noreferrer"
        title={source === 'phone' ? `Call (${label})` : search ? `Search ${label} for them` : `Open on ${label}`}
        aria-label={source === 'phone' ? `Call (${label})` : search ? `Search ${label} for them` : `Open their ${label}`}
        onClick={(e) => e.stopPropagation()}
      >
        {icon}
      </a>
    );
  }
  return (
    <span
      className={`source-icon off${missing ? ' missing' : ''}`}
      title={missing ? `Not on their ${label}` : `${label} (no profile link)`}
      aria-label={missing ? `${label}: not connected` : label}
      role="img"
    >
      {icon}
    </span>
  );
}

const PHONE_OS: 'ios' | 'android' | null =
  typeof navigator === 'undefined'
    ? null
    : /android/i.test(navigator.userAgent)
      ? 'android'
      : /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        ? 'ios'
        : null;

/**
 * A big, tappable contact icon for the phone layout: calls for Contacts, and opens Instagram,
 * LinkedIn and Facebook in their own app when it's installed (the website otherwise).
 */
export function ContactButton({ source, href, name, caption }: { source: string; href: string; name?: string; caption?: string }) {
  const [label, color] = SOURCE_STYLE[source] ?? [source, 'var(--muted)'];
  const glyph = SOURCE_GLYPH[source];
  const tel = /^(tel|sms|mailto):/.test(href);
  const app = PHONE_OS ? appProfileUrl(source, href, PHONE_OS) : null;
  const what = href.startsWith('tel:')
    ? `Call ${name ?? ''}`.trim()
    : href.startsWith('sms:')
      ? `Text ${name ?? ''}`.trim()
      : href.startsWith('mailto:')
        ? `Email ${name ?? ''}`.trim()
        : href.includes('facebook.com/search/')
          ? `Search ${label} for them`
          : `Open their ${label}`;
  return (
    <a
      className={`contact-btn${caption ? ' captioned' : ''}`}
      style={{ color }}
      href={app && PHONE_OS === 'android' ? app : href}
      target={tel || app ? undefined : '_blank'}
      rel="noreferrer"
      title={what}
      aria-label={what}
      onClick={(e) => {
        e.stopPropagation();
        if (!app || PHONE_OS !== 'ios') return;
        // Try the app; if the page is still showing a moment later, it isn't installed: use the website.
        e.preventDefault();
        const fallback = setTimeout(() => {
          if (!document.hidden) location.href = href;
        }, 1200);
        const cancel = () => clearTimeout(fallback);
        document.addEventListener('visibilitychange', cancel, { once: true });
        addEventListener('pagehide', cancel, { once: true });
        location.href = app;
      }}
    >
      {glyph ? (
        <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden="true">
          {glyph}
        </svg>
      ) : (
        <span className="source-icon-text">{label.slice(0, 2)}</span>
      )}
      {caption && <span className="contact-caption">{caption}</span>}
    </a>
  );
}

/** "Instagram", "Contacts"…; pass `href` to make it open their profile in a new tab. */
export function SourceBadge({ source, href }: { source: string; href?: string }) {
  const [label, color] = SOURCE_STYLE[source] ?? [source, 'var(--muted)'];
  if (href)
    return (
      <a className="source-badge link" style={{ color, borderColor: color }} href={href} target="_blank" rel="noreferrer" title="Open their profile" onClick={(e) => e.stopPropagation()}>
        {label} ↗
      </a>
    );
  return (
    <span className="source-badge" style={{ color, borderColor: color }}>
      {label}
    </span>
  );
}

export const instagramUrl = (username: string) => `https://www.instagram.com/${username.replace(/^@/, '')}/`;

export function PersonRow({ person, subtitle, right, queue }: { person: Person; subtitle?: ReactNode; right?: ReactNode; queue?: string }) {
  const sub = subtitle ?? ([person.how_met, person.company].filter(Boolean).join(' · ') || person.phone || person.email || '');
  return (
    <li className={`person-row${person.status === 'archived' ? ' dim' : ''}`}>
      <Link to={`/person/${person.id}${queue ? `?queue=${queue}` : ''}`} className="person-link">
        <Avatar name={person.name} photo={person.photo} />
        <span className="person-text">
          <span className="person-name">{person.name}</span>
          {sub && <span className="person-sub">{sub}</span>}
        </span>
      </Link>
      {right && <div className="person-right">{right}</div>}
    </li>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

/** "📸 312 of 1,693 have pictures · updated 3 days ago" with a Fetch pictures link. */
export function PhotoIndicator({ withPhoto, total, updatedAt, fetchLink = true }: { withPhoto: number; total: number; updatedAt: string | null; fetchLink?: boolean }) {
  const days = updatedAt ? Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86400000) : null;
  const ago = days === null ? 'never fetched' : days === 0 ? 'updated today' : days === 1 ? 'updated yesterday' : `updated ${days} days ago`;
  const stale = days === null || days > 30;
  return (
    <span className={`photo-indicator${stale ? ' stale' : ''}`} title={updatedAt ? `Pictures last updated ${new Date(updatedAt).toLocaleString()}` : 'Pictures have never been fetched'}>
      📸 {withPhoto.toLocaleString()} of {total.toLocaleString()} have pictures · {ago}
      {fetchLink && (
        <>
          {' · '}
          <Link to="/photos?fetch=1">Fetch pictures</Link>
        </>
      )}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** Dropdown of colored labels, anchored to the element that opened it (board-style status menu). */
export function LabelMenu<K extends string>({
  anchor,
  title,
  options,
  current,
  clearLabel,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  title?: string;
  options: { key: K; label: string; color: string }[];
  current: K | null;
  clearLabel: string;
  onPick: (k: K | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const m = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.left + a.width / 2 - m.width / 2, innerWidth - m.width - 8));
    const below = a.bottom + 6;
    const top = below + m.height > innerHeight - 8 ? Math.max(8, a.top - m.height - 6) : below;
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onScroll = () => onClose();
    addEventListener('keydown', onKey);
    addEventListener('pointerdown', onDown, true);
    addEventListener('scroll', onScroll, true);
    ref.current?.querySelector('button')?.focus();
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('pointerdown', onDown, true);
      removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;
  return (
    <div ref={ref} className="label-menu" role="menu" style={pos ?? { top: -9999, left: -9999 }}>
      {title && <div className="label-menu-title">{title}</div>}
      {options.map((o) => (
        <button key={o.key} type="button" role="menuitem" className="label-opt" style={{ background: o.color }} onClick={() => onPick(o.key)}>
          {o.label}
          {current === o.key && <span>✓</span>}
        </button>
      ))}
      <button type="button" role="menuitem" className="label-opt clear" onClick={() => onPick(null)}>
        {clearLabel}
      </button>
    </div>
  );
}

export function Modal({ open, title, onClose, children, dismissible = true }: { open: boolean; title: string; onClose: () => void; children: ReactNode; dismissible?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={onClose}
      onCancel={(e) => !dismissible && e.preventDefault()}
      onClick={(e) => dismissible && e.target === ref.current && onClose()}
    >
      <div className="modal-body">
        <div className="modal-head">
          <h2>{title}</h2>
          {dismissible && (
            <button type="button" className="btn ghost" onClick={onClose}>
              Close
            </button>
          )}
        </div>
        {open && children}
      </div>
    </dialog>
  );
}

/** Which page numbers to show: always the first and last, plus a few around the current page. */
export function pageNumbers(current: number, total: number): (number | 'gap')[] {
  // A run of up to 7 numbers around the current page (slid inward at the ends), like Google.
  const run = Math.min(7, total);
  const start = Math.max(0, Math.min(current - 3, total - run));
  const keep = new Set([0, total - 1]);
  for (let i = start; i < start + run; i++) keep.add(i);
  const out: (number | 'gap')[] = [];
  let prev = -1;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - prev > 1) out.push('gap');
    out.push(n);
    prev = n;
  }
  return out;
}

/** Google-style page links: ‹ Previous 1 … 4 5 [6] 7 8 … 36 Next ›. `page` is 0-based. */
export function Pager({ page, pageSize, count, onChange }: { page: number; pageSize: number; count: number; onChange: (page: number) => void }) {
  const total = Math.ceil(count / pageSize);
  if (total <= 1) return null;
  const go = (p: number) => {
    onChange(p);
    window.scrollTo({ top: 0 });
  };
  return (
    <nav className="pager" aria-label="Pages">
      <span className="pager-info small muted">
        {(page * pageSize + 1).toLocaleString()}–{Math.min(count, (page + 1) * pageSize).toLocaleString()} of {count.toLocaleString()}
      </span>
      <div className="pager-links">
        <button type="button" className="pager-btn" disabled={page === 0} onClick={() => go(page - 1)} aria-label="Previous page">
          ‹<span className="pager-word"> Previous</span>
        </button>
        {pageNumbers(page, total).map((n, i) =>
          n === 'gap' ? (
            <span key={`gap${i}`} className="pager-gap">…</span>
          ) : (
            <button key={n} type="button" className={`pager-btn num${n === page ? ' current' : ''}`} aria-current={n === page ? 'page' : undefined} onClick={() => go(n)}>
              {n + 1}
            </button>
          ),
        )}
        <button type="button" className="pager-btn" disabled={page >= total - 1} onClick={() => go(page + 1)} aria-label="Next page">
          <span className="pager-word">Next </span>›
        </button>
      </div>
      {total > 5 && <PageJump total={total} onGo={go} />}
    </nav>
  );
}

/** Type a page number and press Enter (or Go) to jump straight there. */
function PageJump({ total, onGo }: { total: number; onGo: (page: number) => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const n = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= total;
  const jump = () => {
    if (!valid) return;
    onGo(n - 1);
    setText('');
  };
  return (
    <span className="pager-jump small">
      <label htmlFor={id} className="muted">Go to page</label>
      <input
        id={id}
        className="input pager-jump-input"
        type="number"
        inputMode="numeric"
        min={1}
        max={total}
        placeholder={`1–${total}`}
        value={text}
        aria-invalid={text !== '' && !valid}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            jump();
          }
        }}
      />
      <button type="button" className="pager-btn" disabled={!valid} onClick={jump}>
        Go
      </button>
    </span>
  );
}
