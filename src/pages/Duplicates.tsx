import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Avatar, Empty, PageHead, Pager, SourceIcon, TagChip } from '@/components/ui';
import { dismissDuplicate, listDuplicates, mergeAllLikely, mergePeople, richness } from '@/db/merge';
import { getPerson, listPeople, updatePerson, type Person, type PersonListRow } from '@/db/people';
import { DUP_REASONS, nameOptions, type DupPair } from '@/lib/duplicates';
import { formatBirthday, formatDate } from '@/lib/dates';
import { shrinkImage } from '@/lib/image';
import { useQuery, useStore } from '@/lib/store';

const PAGE = 20;

export function Duplicates() {
  const { db, bump } = useStore();
  const [tab, setTab] = useState<'likely' | 'maybe'>('likely');
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);

  const data = useQuery(async () => {
    const pairs = await listDuplicates(db);
    const people = new Map((await listPeople(db, {})).map((p) => [p.id, p]));
    return { pairs: pairs.filter((p) => people.has(p.a) && people.has(p.b)), people };
  });
  if (!data) return null;

  const likely = data.pairs.filter((p) => p.strong);
  const maybe = data.pairs.filter((p) => !p.strong);
  const shown = tab === 'likely' ? likely : maybe;
  const pg = Math.min(page, Math.max(0, Math.ceil(shown.length / PAGE) - 1));

  return (
    <div className="page dup-page">
      <PageHead
        title="Merge duplicates"
        sub="The same person can show up twice, e.g. as an Instagram follower (jackiezhang26) and as a chat contact (Jackie Zhang). Merging keeps everything from both: notes, tags, chats, rankings and where they came from."
      />
      {notice && <p className="notice" role="status">✓ {notice}</p>}

      {data.pairs.length === 0 ? (
        <Empty>
          No duplicates found. 🎉 <Link to="/people">Back to People</Link>
        </Empty>
      ) : (
        <>
          <div className="chips" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={tab === 'likely'} className={`chip${tab === 'likely' ? ' active' : ''}`} onClick={() => { setTab('likely'); setPage(0); }}>
              Likely the same · {likely.length.toLocaleString()}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'maybe'} className={`chip${tab === 'maybe' ? ' active' : ''}`} onClick={() => { setTab('maybe'); setPage(0); }}>
              Maybe · {maybe.length.toLocaleString()}
            </button>
          </div>
          {tab === 'likely' && likely.length > 1 && (
            <section className="card pad row-gap merge-all">
              <span className="small grow">
                Merge all {likely.length.toLocaleString()} likely pairs at once. Each keeps the proper “First Last” name, and anyone who matches more than one person is left for you to
                check. Merges can’t be undone, so <Link to="/sync">download a backup</Link> first.
              </span>
              <button
                type="button"
                className="btn primary"
                disabled={busyAll}
                onClick={async () => {
                  if (!confirm(`Merge ${likely.length.toLocaleString()} likely duplicate pairs? This can't be undone.`)) return;
                  setBusyAll(true);
                  try {
                    const { merged, skipped } = await mergeAllLikely(db);
                    setNotice(`Merged ${merged.toLocaleString()} pairs.${skipped ? ` ${skipped.toLocaleString()} left below because they match more than one person.` : ''}`);
                    bump();
                  } finally {
                    setBusyAll(false);
                  }
                }}
              >
                {busyAll ? 'Merging…' : `Merge all ${likely.length.toLocaleString()}`}
              </button>
            </section>
          )}
          {shown.length === 0 && <Empty>Nothing here.</Empty>}
          <div className="stack">
            {shown.slice(pg * PAGE, (pg + 1) * PAGE).map((pair) => (
              <PairCard
                key={`${pair.a}:${pair.b}`}
                pair={pair}
                a={data.people.get(pair.a)!}
                b={data.people.get(pair.b)!}
                onMerge={async (keepId, dropId, name) => {
                  await mergePeople(db, keepId, dropId, name);
                  setNotice(`Merged into ${name}.`);
                  bump();
                }}
                onDismiss={async () => {
                  await dismissDuplicate(db, pair.a, pair.b);
                  setNotice(`Got it: ${data.people.get(pair.a)!.name} and ${data.people.get(pair.b)!.name} are different people.`);
                  bump();
                }}
              />
            ))}
          </div>
          <Pager page={pg} pageSize={PAGE} count={shown.length} onChange={setPage} />
        </>
      )}
    </div>
  );
}

function PairCard({ pair, a, b, onMerge, onDismiss }: {
  pair: DupPair;
  a: PersonListRow;
  b: PersonListRow;
  onMerge: (keepId: number, dropId: number, name: string) => Promise<void>;
  onDismiss: () => void;
}) {
  const { db } = useStore();
  // Keep whichever record has more on it; the name is chosen separately.
  const keepId = useQuery(async () => {
    const [pa, pb] = await Promise.all([getPerson(db, a.id), getPerson(db, b.id)]);
    if (!pa || !pb) return a.id;
    return (await richness(db, pb)) > (await richness(db, pa)) ? b.id : a.id;
  }, [a.id, b.id]);
  const [busy, setBusy] = useState(false);
  if (keepId === undefined) return null;
  const keep = keepId === a.id ? a : b;
  const drop = keepId === a.id ? b : a;
  return (
    <section className="card pad dup-card">
      <p className="small muted">
        {DUP_REASONS[pair.reason]}. Not sure? Open their profiles to compare pictures, or paste a picture onto a card to keep it.
      </p>
      <div className="dup-pair">
        <PersonMini p={a} />
        <span className="dup-and" aria-hidden>
          +
        </span>
        <PersonMini p={b} />
      </div>
      <MergeForm
        a={keep}
        b={drop}
        busy={busy}
        onMerge={async (name) => {
          setBusy(true);
          try {
            await onMerge(keep.id, drop.id, name);
          } finally {
            setBusy(false);
          }
        }}
        extra={
          <button type="button" className="btn ghost" onClick={onDismiss}>
            Not the same person
          </button>
        }
      />
    </section>
  );
}

export function MergeForm({ a, b, busy, onMerge, extra }: {
  a: Pick<Person, 'name'> & { sources?: string[] };
  b: Pick<Person, 'name'> & { sources?: string[] };
  busy?: boolean;
  onMerge: (name: string) => void;
  extra?: ReactNode;
}) {
  const options = nameOptions(a, b);
  const [choice, setChoice] = useState(options[0]);
  const [custom, setCustom] = useState('');
  const group = useId(); // each form needs its own radio group
  const name = choice === '__custom' ? custom.trim() : choice;
  return (
    // Not a <form>: this also appears inside the person page's edit form, and forms can't nest.
    <div className="stack merge-form">
      <fieldset className="merge-names">
        <legend className="small">Name after merging</legend>
        {options.map((o) => (
          <label key={o} className="check">
            <input type="radio" name={group} checked={choice === o} onChange={() => setChoice(o)} />
            {o}
          </label>
        ))}
        <label className="check">
          <input type="radio" name={group} checked={choice === '__custom'} onChange={() => setChoice('__custom')} />
          <input
            className="input"
            placeholder="Something else…"
            value={custom}
            aria-label="Another name"
            onFocus={() => setChoice('__custom')}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (name) onMerge(name);
              }
            }}
          />
        </label>
      </fieldset>
      <div className="row-gap">
        <button type="button" className="btn primary" disabled={busy || !name} onClick={() => name && onMerge(name)}>
          {busy ? 'Merging…' : 'Merge'}
        </button>
        {extra}
      </div>
    </div>
  );
}

const PROFILE_LABELS: Record<string, string> = { instagram: 'Instagram', linkedin: 'LinkedIn', discord: 'Discord', google: 'Google Contacts', facebook: 'Facebook' };

/**
 * One side of a possible duplicate, laid out to make "is this the same person?" easy: a big photo
 * (paste or drop one in to save it), buttons to open each of their profiles, and the details we have.
 */
function PersonMini({ p }: { p: PersonListRow }) {
  const { db, bump } = useStore();
  const [dragging, setDragging] = useState(false);
  const savePhoto = async (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    await updatePerson(db, p.id, { photo: await shrinkImage(file, 160) });
    bump();
  };
  const profiles = Object.entries(p.links).filter(([s, href]) => href && s !== 'phone') as [string, string][];
  const details = [
    p.city && `📍 ${p.city}`,
    p.birthday && `🎂 ${formatBirthday(p.birthday)}`,
    p.how_met && `🤝 ${p.how_met}`,
    p.company,
    p.email,
    p.phone,
  ].filter(Boolean) as string[];
  return (
    <div
      className={`dup-person${dragging ? ' dragging' : ''}`}
      tabIndex={0}
      title="Paste (Ctrl+V) or drop a picture here to save it as their photo"
      onPaste={(e) => {
        const img = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'));
        if (img) {
          e.preventDefault();
          savePhoto(img);
        }
      }}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        const img = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
        if (img) {
          e.preventDefault();
          savePhoto(img);
        }
      }}
    >
      <div className="dup-photo">
        <Avatar name={p.name} photo={p.photo} size={72} />
        {!p.photo && <span className="dup-photo-hint">No photo</span>}
      </div>
      <div className="person-text">
        <Link to={`/person/${p.id}`} className="person-name" title="Open their page">
          {p.name}
        </Link>
        <span className="badges">
          {p.sources.map((s) => (
            <SourceIcon key={s} source={s} href={p.links[s]} />
          ))}
          {p.tags.slice(0, 3).map((t) => (
            <TagChip key={t} tag={t} />
          ))}
        </span>
        {details.length > 0 ? (
          <ul className="dup-details">
            {details.slice(0, 4).map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : (
          <span className="person-sub">Added {formatDate(p.created_at.slice(0, 10))}</span>
        )}
        {profiles.length > 0 && (
          <span className="dup-profiles">
            {profiles.map(([s, href]) => (
              <a key={s} className="btn ghost small" href={href} target="_blank" rel="noreferrer">
                {PROFILE_LABELS[s] ?? s} ↗
              </a>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
