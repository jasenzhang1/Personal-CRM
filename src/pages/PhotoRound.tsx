import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Avatar, Empty, PageHead, PhotoIndicator } from '@/components/ui';
import { getSetting, listPeople } from '@/db/people';
import { eachLimited, gravatarUrl, imageExists } from '@/lib/gravatar';
import { fetchGoogleContacts } from '@/sync/google';
import { ingest } from '@/sync/ingest';
import { loadScores } from '@/db/ranking';
import { lastPhotoRound, markPhotoChecked, needEmailPhoto, notePhotosUpdated, photoQueue, photoRoundIcs, photoStatus, PHOTO_ROUND_DAYS, type PhotoTodo } from '@/db/photos';
import { formatDate } from '@/lib/dates';
import { shrinkImage } from '@/lib/image';
import { grabberBookmarklet, isGrabMessage, profileKey } from '@/lib/grabber';
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
  const [round, setRound] = useState(0); // bump to rebuild the queue after fetching
  const status = useQuery(() => photoStatus(db), [done, round]);
  const googleId = useQuery(async () => (await getSetting(db, 'google_client_id')) ?? '', []);
  const [fetching, setFetching] = useState<{ step: string; done: number; total: number } | null>(null);
  const [fetchResult, setFetchResult] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  /** Gravatar: free, public pictures linked to an email address. Sends only a scrambled (hashed) email. */
  const fetchGravatars = async () => {
    const todo = await needEmailPhoto(db);
    let found = 0;
    setFetching({ step: 'Checking Gravatar', done: 0, total: todo.length });
    let n = 0;
    await eachLimited(todo, 6, async (p) => {
      const url = await gravatarUrl(p.email);
      if (await imageExists(url)) {
        await markPhotoChecked(db, p.id, url, false); // keeps d=404: if they remove it later, initials show instead of a placeholder
        found++;
      }
      setFetching({ step: 'Checking Gravatar', done: ++n, total: todo.length });
    });
    return { found, checked: todo.length };
  };

  const fetchAll = async (withGoogle: boolean) => {
    setFetchResult(null);
    const before = (await photoStatus(db)).withPhoto;
    const parts: string[] = [];
    try {
      const g = await fetchGravatars();
      parts.push(`Gravatar: ${g.found} of ${g.checked} people with an email`);
      if (withGoogle && googleId) {
        setFetching({ step: 'Syncing Google contacts', done: 0, total: 0 });
        await ingest(db, 'google', await fetchGoogleContacts(googleId));
        parts.push('Google contacts synced');
      }
    } catch (e) {
      parts.push(`Stopped: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await notePhotosUpdated(db);
      const after = (await photoStatus(db)).withPhoto;
      setFetching(null);
      const found = after - before;
      const total = (await photoStatus(db)).total;
      const withEmail = (await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM people WHERE status != 'archived' AND email LIKE '%@%'"))?.n ?? 0;
      // Explain a small result instead of leaving it looking broken.
      const why: string[] = [];
      if (withEmail < total / 5)
        why.push(`Gravatar needs an email address, and only ${withEmail.toLocaleString()} of your ${total.toLocaleString()} people have one (Instagram and LinkedIn exports don’t include emails)`);
      if (!googleId) why.push('Google contact photos need “Sync with Google” set up on the Import page');
      setFetchResult(
        `Found ${found.toLocaleString()} new ${found === 1 ? 'picture' : 'pictures'} (${parts.join(' · ')}).` +
          (found === 0 && why.length ? ` That’s expected: ${why.join('; ')}. Most pictures will come from the Instagram/LinkedIn round below.` : ''),
      );
      setRound((r) => r + 1);
      bump();
    }
  };

  // "Fetch pictures" on People lands here with ?fetch=1: start right away.
  useEffect(() => {
    if (params.get('fetch') === '1' && !fetching) {
      setParams({}, { replace: true });
      fetchAll(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build the queue once per round (closest people first); it doesn't reshuffle while you work.
  useEffect(() => {
    (async () => {
      const people = await listPeople(db, { status: ['new', 'backlog', 'reviewed'] });
      const scores = await loadScores(db, people);
      const order = new Map([...scores].map(([id, s]) => [id, s.score]));
      setQueue(await photoQueue(db, { refresh, order }));
      setIndex(0);
    })();
  }, [db, refresh, round]);

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

  // Pictures sent by the "Grab picture" bookmark from the profile tab. We save it to whoever that
  // profile belongs to and answer with the next profile, which the bookmark opens.
  useEffect(() => {
    if (!queue) return;
    const onMessage = async (e: MessageEvent) => {
      if (!isGrabMessage(e)) return;
      const reply = (msg: { url?: string; message?: string }) => (e.source as Window | null)?.postMessage({ type: 'crm-next', ...msg }, e.origin);
      const key = profileKey(e.data.page);
      const matches = (p: PhotoTodo) => !!key && p.profiles.some((x) => x.source === key.source && profileKey(x.url)?.id === key.id);
      let at = queue.findIndex((p, i) => i >= index && matches(p));
      if (at < 0) at = queue.findIndex(matches);
      if (at < 0) return reply({ message: 'This profile isn’t in your photo round. Open profiles from the Photo round so the picture goes to the right person.' });
      const person = queue[at];
      let photo: string | undefined;
      try {
        if (e.data.data) photo = await shrinkImage(e.data.data, 160);
        else if (e.data.src) {
          try {
            photo = await shrinkImage(e.data.src, 160);
          } catch {
            photo = e.data.src; // the site didn't let us copy it; keep the link (refreshed next round)
          }
        }
      } catch {
        photo = undefined;
      }
      await markPhotoChecked(db, person.id, photo);
      if (photo) setDone((d) => d + 1);
      const n = at + 1;
      setIndex(n);
      setError(null);
      bump();
      const upcoming = queue[n];
      reply(upcoming ? { url: upcoming.profiles[0].url } : { message: `All done! ${photo ? 'Saved ' + person.name + '’s picture. ' : ''}That’s everyone in this round 🎉` });
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [queue, index, db, bump]);

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

      {status && <PhotoIndicator withPhoto={status.withPhoto} total={status.total} updatedAt={status.updatedAt} fetchLink={false} />}

      <section className="card pad fetch-card">
        <div className="row-gap">
          <span className="grow">
            <strong>Fetch automatically</strong>
            <span className="block small muted">
              Gravatar (the profile picture people set up through WordPress, GitHub, Slack and others; checked using a scrambled version of their email)
              {googleId ? ' and your Google contacts’ photos' : ''}. Instagram and LinkedIn don’t allow automatic fetching, so for those use the 📸 Grab picture bookmark below.
            </span>
          </span>
          <button type="button" className="btn primary" disabled={!!fetching} onClick={() => fetchAll(true)}>
            {fetching ? 'Fetching…' : '📸 Fetch pictures'}
          </button>
        </div>
        {fetching && (
          <>
            <span className="small muted">
              {fetching.step}
              {fetching.total ? ` · ${fetching.done.toLocaleString()} of ${fetching.total.toLocaleString()}` : '…'}
            </span>
            {fetching.total > 0 && (
              <div className="fetch-progress">
                <span style={{ width: `${(fetching.done / fetching.total) * 100}%` }} />
              </div>
            )}
          </>
        )}
        {fetchResult && (
          <p className="small" role="status">
            ✓ {fetchResult} {queue && queue.length > 0 ? `${queue.length.toLocaleString()} still need one from Instagram or LinkedIn. Keep going below.` : ''}
          </p>
        )}
      </section>

      <h2 className="section-title">From Instagram & LinkedIn</h2>
      <GrabberSetup />
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
            <li>Open their profile (button above, or press Enter). With the 📸 Grab picture bookmark, just click it on their profile: it saves the picture and opens the next person. Or by hand:</li>
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

/** One-time setup for the bookmark, with a button you drag to the bookmarks bar. */
function GrabberSetup() {
  const link = useRef<HTMLAnchorElement>(null);
  // React won't render javascript: links, so set it directly.
  useEffect(() => {
    link.current?.setAttribute('href', grabberBookmarklet());
  }, []);
  return (
    <section className="card pad grabber">
      <div className="row-gap">
        <a ref={link} className="btn primary grab-link" onClick={(e) => e.preventDefault()} draggable title="Drag me to your bookmarks bar">
          📸 Grab picture
        </a>
        <span className="small grow">
          <strong>Fastest way: drag this button to your bookmarks bar</strong> (press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> if you don’t see the bar). Then start the round, and on each
          Instagram or LinkedIn profile just click the bookmark. It saves their picture here and jumps to the next person, about 2 seconds each.
        </span>
      </div>
      <p className="small muted">
        It only reads the picture already on your screen, in your own signed-in browser, so it’s the same as looking at the profile yourself. Nothing runs on its own. Works in
        Chrome, Edge and Firefox on a computer.
      </p>
    </section>
  );
}
