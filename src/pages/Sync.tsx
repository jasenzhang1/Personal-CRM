import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { applyNameSuggestions, AUTO_NAMES_KEY, nameReviewList } from '@/db/names';
import { listDuplicates } from '@/db/merge';
import { PageHead, SourceBadge } from '@/components/ui';
import { getSetting, setSetting } from '@/db/people';
import { SOURCE_LABELS } from '@/lib/constants';
import { daysBetween, isoDate } from '@/lib/dates';
import { shrinkPhotos } from '@/lib/image';
import { migrate } from '@/db/schema';
import { useQuery, useStore } from '@/lib/store';
import { expandFiles } from '@/sync/files';
import { fetchGoogleContacts } from '@/sync/google';
import { ingest, type IngestResult } from '@/sync/ingest';
import { fromContactPicker, parseMany } from '@/sync/parsers';
import { isMessageEntry, parseChats } from '@/sync/messages';
import { describeChats, importChats } from '@/sync/activity';
import { applyInstagramNames, isInstagramNameEntry, parseInstagramNames } from '@/sync/igNames';
import { describeFollowSync, exportDateOf, followListKind, isUnfollowedByMeEntry, parseFollowList, recordUnfollowedByMe, syncFollowList } from '@/sync/igFollows';

type FileSource = { key: string; title: string; link: string; linkLabel: string; drop: string; wait: string; steps: string[] };

const FILE_SOURCES: FileSource[] = [
  {
    key: 'phone',
    title: 'iPhone contacts',
    link: 'https://www.icloud.com/contacts/',
    linkLabel: 'Open iCloud Contacts',
    drop: 'the .vcf file',
    wait: 'Instant',
    steps: [
      'Sign in with your Apple ID.',
      'Click any contact, press Ctrl+A (⌘A on Mac) to select all.',
      'Click ⋯ (or the ⚙︎ gear) → Export vCard. Drop the .vcf here.',
      'Contact photos come along too. Imported before? Drop it again to add any missing photos.',
    ],
  },
  {
    key: 'linkedin',
    title: 'LinkedIn',
    link: 'https://www.linkedin.com/mypreferences/d/download-my-data',
    linkLabel: 'Open LinkedIn data export',
    drop: 'the .zip',
    wait: '10 minutes to 24 hours, by email',
    steps: ['Choose the first option, “Download larger data archive” (Connections is often missing from the “Want something in particular?” list).', 'Click Request archive and enter your password.', 'When LinkedIn emails you, download the .zip (or every .zip, if it sends more than one) and drop it here.'],
  },
  {
    key: 'instagram',
    title: 'Instagram',
    link: 'https://accountscenter.instagram.com/info_and_permissions/dyi/',
    linkLabel: 'Open Instagram export',
    drop: 'the .zip',
    wait: 'Minutes to a few hours',
    steps: [
      'Download or transfer information → your account → Some of your information.',
      'Tick Followers and following, and Messages (for chat and call counts) → Download to device.',
      'Date range: All time. Format: JSON. Create files.',
      'When it’s ready, download the .zip and drop it here.',
    ],
  },
  {
    key: 'facebook',
    title: 'Facebook',
    link: 'https://accountscenter.facebook.com/info_and_permissions/dyi/',
    linkLabel: 'Open Facebook export',
    drop: 'the .zip',
    wait: 'Minutes to a few hours',
    steps: [
      'Download or transfer information → your profile → Some of your information.',
      'Tick Friends, and Messages (for chat and call counts) → Download to device.',
      'Date range: All time. Format: JSON. Create files.',
      'When it’s ready, download the .zip and drop it here.',
    ],
  },
  {
    key: 'discord',
    title: 'Discord',
    link: 'https://discord.com/app',
    linkLabel: 'Open Discord',
    drop: 'package.zip',
    wait: 'Usually 1–3 days, by email',
    steps: [
      'User Settings (⚙︎) → Data & Privacy → Request all of my data (tick Account, plus Messages for DM counts).',
      'When Discord emails you, download package.zip and drop it here. Your friends list comes from it.',
    ],
  },
];

const REFRESH_AFTER_DAYS = 60;

type Log = { ok: boolean; text: string; link?: { to: string; label: string } };

const describe = (r: IngestResult) =>
  `${SOURCE_LABELS[r.source]}: ${r.total} found · ${r.added} new${r.added ? (r.baseline ? ' → Older connections' : ' → Inbox') : ''} · ${r.linked} matched to people you already had`;

declare global {
  interface Navigator {
    contacts?: { select(props: string[], opts?: { multiple?: boolean }): Promise<{ name?: string[]; tel?: string[]; email?: string[] }[]> };
  }
}

export function Sync() {
  const { db, bump, proMode, setProMode } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Log[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);

  const status = useQuery(async () => {
    const counts = new Map(
      (await db.getAllAsync<{ source: string; n: number }>('SELECT source, COUNT(*) AS n FROM sources GROUP BY source')).map((r) => [r.source, r.n]),
    );
    const last: Record<string, string | null> = {};
    for (const k of Object.keys(SOURCE_LABELS)) last[k] = await getSetting(db, `last_sync_${k}`);
    return { counts, last, googleClientId: (await getSetting(db, 'google_client_id')) ?? '' };
  });
  const totals = useQuery(() => db.getFirstAsync<{ people: number }>('SELECT COUNT(*) AS people FROM people'));

  const addLog = (entries: Log[]) => setLog((l) => [...entries, ...l]);

  /**
   * Instagram followers/following: save a snapshot per export and compare with the last one, so
   * we can tell who unfollowed you. Several exports dropped at once are applied oldest first.
   */
  const trackFollows = async (entries: { name: string; text: string }[]): Promise<Log[]> => {
    const out: Log[] = [];
    const byExport = new Map<string, { name: string; text: string }[]>();
    for (const e of entries) if (followListKind(e.name)) byExport.set(e.name.split(' › ')[0], [...(byExport.get(e.name.split(' › ')[0]) ?? []), e]);
    const exports = [...byExport.values()].sort((a, b) => (exportDateOf(a[0].name) ?? '').localeCompare(exportDateOf(b[0].name) ?? ''));
    for (const files of exports) {
      const date = exportDateOf(files[0].name) ?? isoDate();
      for (const kind of ['followers', 'following'] as const) {
        const lists = files.filter((e) => followListKind(e.name) === kind);
        if (!lists.length) continue;
        const r = await syncFollowList(db, kind, lists.flatMap((e) => parseFollowList(e.text)), date);
        out.push({ ok: true, text: describeFollowSync(r), link: { to: '/followers', label: 'See followers →' } });
      }
    }
    const mine = entries.filter((e) => isUnfollowedByMeEntry(e.name)).flatMap((e) => parseFollowList(e.text));
    if (mine.length) await recordUnfollowedByMe(db, mine);
    return out;
  };

  /** After an import: apply sure-thing name fixes (unless turned off) and point to the rest. */
  const cleanNames = async (): Promise<Log[]> => {
    const auto = (await getSetting(db, AUTO_NAMES_KEY)) !== '0';
    const { fixed, left } = auto ? await applyNameSuggestions(db) : { fixed: 0, left: (await nameReviewList(db)).length };
    const out: Log[] = [];
    if (fixed) out.push({ ok: true, text: `Cleaned up ${fixed.toLocaleString()} ${fixed === 1 ? 'name' : 'names'} (e.g. usernames → First Last).` });
    if (left) out.push({ ok: true, text: `${left.toLocaleString()} ${left === 1 ? 'name still needs' : 'names still need'} a look.`, link: { to: '/names', label: 'Clean up names →' } });
    const dupes = (await listDuplicates(db)).filter((p) => p.strong).length;
    if (dupes) out.push({ ok: true, text: `${dupes.toLocaleString()} ${dupes === 1 ? 'person looks' : 'people look'} like they're in here twice.`, link: { to: '/duplicates', label: 'Merge duplicates →' } });
    return out;
  };

  const importFiles = async (files: File[]) => {
    setBusy('files');
    try {
      const { entries, notes } = await expandFiles(files);
      const chatEntries = entries.filter((e) => isMessageEntry(e.name));
      const nameEntries = entries.filter((e) => isInstagramNameEntry(e.name));
      const batch = parseMany(entries.filter((e) => !isMessageEntry(e.name) && !isInstagramNameEntry(e.name)));
      const out: Log[] = notes.map((text) => ({ ok: false, text }));
      for (const f of batch.files) if (f.error) out.push({ ok: false, text: `${f.name}: ${f.error}` });
      for (const [kind, candidates] of batch.bySource) out.push({ ok: true, text: describe(await ingest(db, kind, await shrinkPhotos(candidates))) });
      // Real names from Close Friends / follow requests first, then chats last, so chats can match
      // the people (and names) this same import just added.
      if (nameEntries.length) {
        const named = await applyInstagramNames(db, nameEntries.flatMap((e) => parseInstagramNames(e.text)));
        if (named) out.push({ ok: true, text: `Found real names for ${named.toLocaleString()} Instagram ${named === 1 ? 'account' : 'accounts'} (from Close Friends and follow requests).` });
      }
      if (chatEntries.length) for (const r of await importChats(db, parseChats(chatEntries))) out.push({ ok: true, text: describeChats(r) });
      out.push(...(await trackFollows(entries)));
      if (!out.length) out.push({ ok: false, text: 'Nothing to import in those files.' });
      else if (out.some((l) => l.ok)) out.push(...(await cleanNames()));
      addLog(out);
    } catch (e) {
      addLog([{ ok: false, text: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(null);
      bump();
    }
  };

  const syncGoogle = async () => {
    if (!status?.googleClientId) return;
    setBusy('google');
    try {
      addLog([{ ok: true, text: describe(await ingest(db, 'google', await fetchGoogleContacts(status.googleClientId))) }, ...(await cleanNames())]);
    } catch (e) {
      addLog([{ ok: false, text: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(null);
      bump();
    }
  };

  const pickContacts = async () => {
    try {
      const picked = await navigator.contacts!.select(['name', 'tel', 'email'], { multiple: true });
      if (picked.length) addLog([{ ok: true, text: describe(await ingest(db, 'phone', fromContactPicker(picked))) }, ...(await cleanNames())]);
      bump();
    } catch (e) {
      addLog([{ ok: false, text: String(e) }]);
    }
  };

  const downloadBackup = () => {
    const blob = new Blob([db.exportFile() as BlobPart], { type: 'application/x-sqlite3' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `personal-crm-backup-${isoDate()}.sqlite`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const restoreBackup = async (f: File) => {
    if (!confirm(`Replace everything in this browser with “${f.name}”? Your current data here will be overwritten.`)) return;
    try {
      await db.importFile(new Uint8Array(await f.arrayBuffer()));
      await migrate(db); // older backups get the newer columns
      bump();
      alert('Backup restored.');
    } catch {
      alert("That file isn't a Personal CRM backup.");
    }
  };

  const sourceStatus = (key: string) => {
    const last = status?.last[key];
    const n = status?.counts.get(key) ?? 0;
    if (!last) return <span className="muted small">Not imported yet</span>;
    const age = daysBetween(new Date(last), new Date());
    return (
      <span className="small">
        <span className="muted">
          {n} {n === 1 ? 'person' : 'people'} · updated {age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}
        </span>
        {age >= REFRESH_AFTER_DAYS && <span className="tag">Time to refresh</span>}
      </span>
    );
  };

  return (
    <div className="page">
      <PageHead title="Import & settings" sub="Bring in everyone you know. Re-import any time; only new people land in your Inbox." />

      <section
        className={`dropzone big${dragging ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) importFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <div className="drop-icon">⤓</div>
        <strong>Drop any export here</strong>
        <span className="muted small">Whole .zip files are fine, no need to unzip. You can also drop .vcf, .csv or .json files, several at once.</span>
        <div className="row-gap center">
          <button className="btn primary" disabled={!!busy} onClick={() => fileRef.current?.click()}>
            {busy === 'files' ? 'Importing…' : 'Choose files'}
          </button>
          {navigator.contacts?.select && (
            <button className="btn secondary" onClick={pickContacts}>
              Pick from this phone's contacts
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept=".zip,.vcf,.vcard,.csv,.json,application/zip,text/vcard,text/csv,application/json"
          onChange={(e) => {
            if (e.target.files?.length) importFiles(Array.from(e.target.files));
            e.target.value = '';
          }}
        />
      </section>

      {log.length > 0 && (
        <ul className="import-log" aria-live="polite">
          {log.map((l, i) => (
            <li key={i} className={l.ok ? 'ok' : 'err'}>
              {l.ok ? '✓ ' : '⚠ '}
              {l.text}
              {l.link && (
                <>
                  {' '}
                  <Link to={l.link.to}>{l.link.label}</Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <GoogleCard
        clientId={status?.googleClientId ?? ''}
        busy={busy === 'google'}
        status={sourceStatus('google')}
        onSync={syncGoogle}
        onSaveClientId={async (id) => {
          await setSetting(db, 'google_client_id', id.trim() || null);
          bump();
        }}
      />

      <div className="howto-grid">
        {FILE_SOURCES.map((s) => (
          <section key={s.key} className="card pad source-card">
            <header className="source-head">
              <SourceBadge source={s.key} />
              <h3 className="card-title grow">{s.title}</h3>
            </header>
            {sourceStatus(s.key)}
            <a className="btn secondary block" href={s.link} target="_blank" rel="noreferrer">
              {s.linkLabel} ↗
            </a>
            <ol className="steps">
              {s.steps.map((st) => (
                <li key={st}>{st}</li>
              ))}
            </ol>
            <p className="muted small">
              Wait: {s.wait}. Then drop {s.drop} in the box above.
            </p>
          </section>
        ))}
      </div>

      <section className="card pad">
        <label className="toggle-row">
          <span>
            <span className="card-title">Professional mode</span>
            <span className="muted block">
              Adds a Pipeline board for leads and potential clients, with stages, priority, deal value, next steps and a
              lifecycle timeline for each person.
            </span>
          </span>
          <input type="checkbox" className="switch" checked={proMode} onChange={(e) => setProMode(e.target.checked)} />
        </label>
      </section>

      <section className="card pad stack">
        <h2 className="card-title">Your data</h2>
        <p className="muted">
          {totals ? `${totals.people} people. ` : ''}
          Everything is stored privately in this browser on this device. Nothing is uploaded. To move to another device or
          browser, download a backup and restore it there. Clearing your browser's site data erases it, so download a backup now and then.
        </p>
        <div className="row-gap">
          <button className="btn secondary" onClick={downloadBackup}>
            Download backup
          </button>
          <button className="btn ghost" onClick={() => restoreRef.current?.click()}>
            Restore from backup…
          </button>
          <input
            ref={restoreRef}
            type="file"
            hidden
            accept=".sqlite,.db,application/x-sqlite3,application/octet-stream"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) restoreBackup(f);
              e.target.value = '';
            }}
          />
        </div>
      </section>
    </div>
  );
}

function GoogleCard({ clientId, busy, status, onSync, onSaveClientId }: {
  clientId: string;
  busy: boolean;
  status: React.ReactNode;
  onSync: () => void;
  onSaveClientId: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const origin = location.origin;
  const setup = !clientId || editing;
  return (
    <section className="card pad source-card google-card">
      <header className="source-head">
        <SourceBadge source="google" />
        <h3 className="card-title grow">Gmail & Google Contacts</h3>
        <span className="tag live">Live sync</span>
      </header>
      <p className="muted small">
        Imports your saved Google Contacts and everyone you've emailed in Gmail. Read-only, straight from Google to this
        browser. Click Sync any time to pick up new people.
      </p>
      {status}
      {!setup ? (
        <div className="row-gap">
          <button className="btn primary" disabled={busy} onClick={onSync}>
            {busy ? 'Syncing…' : 'Sync with Google'}
          </button>
          <button
            className="btn ghost small"
            onClick={() => {
              setDraft(clientId);
              setEditing(true);
            }}
          >
            Change Client ID
          </button>
        </div>
      ) : (
        <details className="setup" open={!clientId}>
          <summary>One-time setup (about 5 minutes, free)</summary>
          <p className="small muted">
            Google only lets websites read contacts through your own “Client ID”. You create one once, and it stays on this
            device.
          </p>
          <ol className="steps">
            <li>
              Open the <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud console ↗</a>, sign in with the Gmail account you want to sync, and create a project named <b>Personal CRM</b>.
            </li>
            <li>
              Turn on the <a href="https://console.cloud.google.com/apis/library/people.googleapis.com" target="_blank" rel="noreferrer">People API ↗</a> (make sure your new project is selected at the top) → <b>Enable</b>.
            </li>
            <li>
              Open <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform ↗</a> → <b>Get started</b>. App name: Personal CRM. Support email: yours. Audience: <b>External</b>. Contact email: yours. Agree and <b>Create</b>.
            </li>
            <li>
              Go to <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">Audience ↗</a> → <b>Test users</b> → <b>Add users</b> → add your own Gmail address.
            </li>
            <li>
              Go to <a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noreferrer">Clients → Create client ↗</a>. Application type: <b>Web application</b>. Under <b>Authorized JavaScript origins</b>, add{' '}
              <code className="copy" onClick={() => navigator.clipboard?.writeText(origin)} title="Click to copy">{origin}</code>. Click <b>Create</b>.
            </li>
            <li>Copy the <b>Client ID</b> (it ends in <code>.apps.googleusercontent.com</code>) and paste it here:</li>
          </ol>
          <form
            className="row-gap"
            onSubmit={async (e) => {
              e.preventDefault();
              await onSaveClientId(draft);
              setEditing(false);
            }}
          >
            <input className="input grow" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="1234567890-abc123.apps.googleusercontent.com" spellCheck={false} />
            <button className="btn primary" type="submit" disabled={!/\.apps\.googleusercontent\.com\s*$/.test(draft)}>
              Save
            </button>
            {editing && (
              <button className="btn ghost" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </form>
          <p className="small muted">
            When you first sync, Google will say “Google hasn't verified this app”. That's expected for your own personal
            app: click <b>Continue</b>. Google sync works on the computer at {origin}. A phone opening the site through your
            Wi-Fi address can't use it until the site is hosted online.
          </p>
        </details>
      )}
    </section>
  );
}
