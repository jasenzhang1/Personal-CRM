import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Person } from '@/db/people';

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
export function ScoreBadge({ score, rank, title }: { score: number; rank?: number; title?: string }) {
  const level = score >= 7 ? 'high' : score >= 4 ? 'mid' : score > 0 ? 'low' : 'none';
  return (
    <span className={`score ${level}`} title={title} aria-label={`Closeness score ${score.toFixed(1)} out of 10`}>
      <span className="score-num">{score.toFixed(1)}</span>
      <span className="score-bar">
        <span style={{ width: `${score * 10}%` }} />
      </span>
      {rank !== undefined && <span className="score-rank">#{rank}</span>}
    </span>
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
};

export function SourceBadge({ source }: { source: string }) {
  const [label, color] = SOURCE_STYLE[source] ?? [source, 'var(--muted)'];
  return (
    <span className="source-badge" style={{ color, borderColor: color }}>
      {label}
    </span>
  );
}

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
