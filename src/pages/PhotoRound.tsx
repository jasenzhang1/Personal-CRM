import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Empty, PageHead } from '@/components/ui';
import { listPeople } from '@/db/people';
import { loadScores } from '@/db/ranking';
import { lastPhotoRound, markPhotoChecked, photoQueue, photoRoundIcs, PHOTO_ROUND_DAYS, type PhotoTodo } from '@/db/photos';
import { formatDate } from '@/lib/dates';
import { shrinkImage } from '@/lib/image';
import { useQuery, useStore } from '@/lib/store';

/** Every profile opens in this one tab, so tabs don't pile up during a round. */
const PROFILE_TAB = 'crm-photo-round';
const LABEL = { instagram: 'Instagram', linkedin: 'LinkedIn' } as const;

export function PhotoRound() {
  const { db, bump } = useStore();
  const [refresh, setRefresh] = useState(false);
  const [queue, setQueue] = useState<PhotoTodo[] | null>(null);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(0);
  const [autoOpen, setAutoOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pasteBox = useRef<HTMLDivElement>(null);
  const last = useQuery(() => lastPhotoRound(db), [done]);

  // Build the queue once per round (closest people first); it doesn't reshuffle while you work.
  useEffect(() => {
    (async () => {
      const people = await listPeople(db, { status: ['new', 'backlog', 'reviewed'] });
      const scores = await loadScores(db, people);
      const order = new Map([...scores].map(([id, s]) => [id, s.score]));
      setQueue(await photoQueue(db, { refresh, order }));
      setIndex(0);
    })();
  }, [db, refresh]);

  const current = queue?.[index];
  const open = (url: string) => window.open(url, PROFILE_TAB);
  const next = (openNext: boolean) => {
    const n = index + 1;
    setIndex(n);
    setError(null);
    const p = queue?.[n];
    // The paste keystroke counts as a click, so the browser lets us open the next profile.
    if (openNext && autoOpen && p) open(p.profiles[0].url);
    bump();
  };

  const savePhoto = async (file: File | undefined) => {
    if (!current || !file) return;
    if (!file.type.startsWith('image/')) return setError('That isn’t a picture. Right-click their profile picture → Copy image, then paste here.');
    try {
      await markPhotoChecked(db, current.id, await shrinkImage(file, 160));
      setDone((d) => d + 1);
      next(true);
    } catch {
      setError('Couldn’t read that picture. Try copying it again.');
    }
  };

  // Ctrl+V anywhere on the page saves the picture for the current person.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const img = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (img) {
        e.preventDefault();
        savePhoto(img);
      } else if (e.clipboardData?.getData('text')) setError('You pasted text, not a picture. Right-click their profile picture → Copy image.');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Enter' && current) open(current.profiles[0].url);
      if (e.key === 'ArrowRight' && current) next(false);
    };
    addEventListener('paste', onPaste);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('paste', onPaste);
      removeEventListener('keydown', onKey);
    };
  });

  const remindMe = () => {
    const site = location.href.split('#')[0];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([photoRoundIcs(site)], { type: 'text/calendar' }));
    a.download = 'photo-round-reminder.ics';
    a.click();
  };

  if (!queue) return null;
  const total = queue.length;

  return (
    <div className="page photo-round">
      <PageHead
        title="📸 Photo round"
        sub={`Once a month, update profile pictures from Instagram (or LinkedIn). ${last ? `Last round: ${formatDate(last.slice(0, 10))}.` : ''}`}
      >
        <button type="button" className="btn secondary" onClick={remindMe}>
          📅 Remind me monthly
        </button>
      </PageHead>

      <div className="row-gap">
        <label className="check">
          <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} />
          Also re-check people who already have a photo (pictures change)
        </label>
        <label className="check">
          <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} />
          Open the next profile automatically
        </label>
      </div>

      {total === 0 || !current ? (
        <Empty>
          {done
            ? `All done: ${done} ${done === 1 ? 'picture' : 'pictures'} updated. See you next month!`
            : `Nothing to do. Everyone with an Instagram or LinkedIn link has a photo checked in the last ${PHOTO_ROUND_DAYS} days.`}{' '}
          <Link to="/people">Back to People</Link>
        </Empty>
      ) : (
        <section className="card pad round-card">
          <p className="small muted">
            {index + 1} of {total.toLocaleString()} · {done} updated this round
          </p>
          <div className="round-person">
            <Avatar name={current.name} photo={current.photo} size={96} />
            <div className="stack">
              <Link to={`/person/${current.id}`} className="round-name">
                {current.name}
              </Link>
              <span className="small muted">{current.photo ? `Has a photo, last checked ${current.photo_checked_at ? formatDate(current.photo_checked_at.slice(0, 10)) : 'never'}` : 'No photo yet'}</span>
              <div className="row-gap">
                {current.profiles.map((p, i) => (
                  <button key={p.source} type="button" className={`btn ${i === 0 ? 'primary' : 'secondary'}`} onClick={() => open(p.url)}>
                    Open {LABEL[p.source]} ↗
                  </button>
                ))}
              </div>
            </div>
          </div>
          <ol className="steps">
            <li>Open their profile (button above, or press Enter).</li>
            <li>Right-click their profile picture → <strong>Copy image</strong>.</li>
            <li>
              Come back here and press <kbd>Ctrl</kbd>+<kbd>V</kbd>. The next person comes up{autoOpen ? ' and their profile opens' : ''}.
            </li>
          </ol>
          <div
            ref={pasteBox}
            className="paste-box"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-label="Paste their picture here"
            onInput={(e) => (e.currentTarget.textContent = '')}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              savePhoto([...e.dataTransfer.files].find((f) => f.type.startsWith('image/')));
            }}
          >
            Paste or drop their picture here (on a phone: tap, then Paste)
          </div>
          {error && <p className="small text-danger" role="alert">{error}</p>}
          <div className="row-gap">
            <label className="btn ghost small">
              Choose a file…
              <input type="file" accept="image/*" hidden onChange={(e) => savePhoto(e.target.files?.[0])} />
            </label>
            <span className="grow" />
            <button
              type="button"
              className="btn ghost small"
              title="They have no picture, or it hasn't changed: don't ask again this month"
              onClick={async () => {
                await markPhotoChecked(db, current.id);
                next(false);
              }}
            >
              {current.photo ? 'Still the same' : 'No picture to copy'}
            </button>
            <button type="button" className="btn ghost small" onClick={() => next(false)} title="Ask again next time (→ key)">
              Skip →
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
