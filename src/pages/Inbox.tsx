import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Chips, Empty, PageHead, PersonRow, SourceIcon } from '@/components/ui';
import { listPeople, updatePerson, type Person } from '@/db/people';
import { useQuery, useStore } from '@/lib/store';
import { autoContacts, useAutoContacts } from '@/lib/autoContacts';
import { getSetting } from '@/db/people';
import { ago } from '@/lib/dates';

/**
 * People the app noticed that you haven't filled in yet.
 * "New" = showed up after the first import of that source. "Older connections" = everyone
 * who was already there on the first import, so a 900-person address book doesn't flood the inbox.
 */
export function Inbox() {
  const { db, bump, inboxCount } = useStore();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<'new' | 'backlog'>('new');
  const people = useQuery(() => listPeople(db, { status: [queue] }), [queue]);
  const sources = useQuery(async () => {
    const rows = await db.getAllAsync<{ person_id: number; source: string }>('SELECT DISTINCT person_id, source FROM sources');
    const m = new Map<number, string[]>();
    for (const r of rows) m.set(r.person_id, [...(m.get(r.person_id) ?? []), r.source]);
    return m;
  });

  const skip = async (p: Person) => {
    await updatePerson(db, p.id, { status: 'archived' });
    bump();
  };

  return (
    <div className="page">
      <PageHead title="Inbox" sub="New people to fill in while you still remember how you met.">
        {!!people?.length && (
          <button className="btn primary" onClick={() => navigate(`/person/${people[0].id}?queue=${queue}`)}>
            Start filling in ({people.length})
          </button>
        )}
      </PageHead>
      <PhoneContacts />
      <Chips
        label="Queue"
        options={[
          { key: 'new', label: `New (${inboxCount})` },
          { key: 'backlog', label: 'Older connections' },
        ]}
        value={queue}
        onChange={setQueue}
      />
      {people && people.length > 0 && (
        <ul className="list card">
          {people.map((p) => (
            <PersonRow
              key={p.id}
              person={p}
              queue={queue}
              subtitle={p.company ?? p.phone ?? p.email ?? undefined}
              right={
                <>
                  <span className="badges">{(sources?.get(p.id) ?? []).map((s) => <SourceIcon key={s} source={s} />)}</span>
                  <button className="btn ghost small" onClick={() => skip(p)} title="Hide — not someone to track">
                    Skip
                  </button>
                </>
              }
            />
          ))}
        </ul>
      )}
      {people && people.length === 0 && (
        <Empty>
          {queue === 'new' ? (
            <>
              You're all caught up. When you import contacts again, anyone new lands here so you can note how you met.{' '}
              <Link to="/sync">Import contacts →</Link>
            </>
          ) : (
            <>
              No older connections waiting. <Link to="/sync">Import your phone contacts, LinkedIn, Instagram or Facebook →</Link>
            </>
          )}
        </Empty>
      )}
    </div>
  );
}

/**
 * New contacts from your phone, checked automatically (see lib/autoContacts). Shows who just
 * arrived, how to set it up, and when it last checked.
 */
function PhoneContacts() {
  const auto = useAutoContacts();
  const { db } = useStore();
  const hasGoogle = useQuery(async () => !!(await getSetting(db, 'google_client_id')));
  const [open, setOpen] = useState(false);
  const busy = auto.status === 'checking';

  const howTo = (
    <ol className="steps small">
      <li>
        On your iPhone: <b>Settings → Apps → Contacts → Contacts Accounts</b>. Add your Gmail account if it isn't there, and
        turn on <b>Contacts</b> for it.
      </li>
      <li>
        Back in <b>Settings → Apps → Contacts</b>, set <b>Default Account</b> to <b>Gmail</b>. From now on, every contact you
        add on your phone is saved to Google too.
      </li>
      <li>
        {hasGoogle ? (
          <>Turn this on below. Whenever you open this app, it checks Google for new contacts and puts them here.</>
        ) : (
          <>
            Set up <Link to="/sync">Sync with Google</Link> (one time, about 5 minutes), then come back and turn this on.
          </>
        )}
      </li>
    </ol>
  );

  return (
    <>
      {auto.arrived.length > 0 && (
        <p className="notice cloud-notice row-gap" role="status">
          <span className="grow">
            📱 New from your phone: <b>{auto.arrived.slice(0, 3).map((a) => a.name).join(', ')}</b>
            {auto.arrived.length > 3 && ` and ${auto.arrived.length - 3} more`}. Add how you met, notes and tags while it's fresh.
          </span>
          <Link className="btn primary small" to={`/person/${auto.arrived[0].id}?queue=new`}>
            Fill in →
          </Link>
          <button className="btn ghost small" onClick={() => autoContacts.dismissArrived()} aria-label="Dismiss">
            ✕
          </button>
        </p>
      )}
      {auto.baseline && !auto.arrived.length && (
        <p className="notice cloud-notice row-gap" role="status">
          <span className="grow">
            📱 Connected. The contacts already in Google were filed under <b>Older connections</b>. Contacts you add from now on will
            show up here.
          </span>
          <button className="btn ghost small" onClick={() => autoContacts.dismissArrived()} aria-label="Dismiss">
            ✕
          </button>
        </p>
      )}
      {auto.enabled ? (
        <p className="small muted row-gap phone-auto">
          <span className="grow">
            📱 New phone contacts show up here automatically. Checked {busy ? 'now…' : ago(auto.lastCheck)}.{' '}
            <button type="button" className="linkish" onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide setup' : 'Not showing up?'}
            </button>
          </span>
          <button className="btn ghost small" disabled={busy} onClick={() => void autoContacts.check(true)}>
            {busy ? 'Checking…' : 'Check now'}
          </button>
          <button className="btn ghost small" onClick={() => confirm('Stop checking for new phone contacts?') && void autoContacts.setEnabled(false)}>
            Turn off
          </button>
        </p>
      ) : (
        <section className="card pad phone-auto-card">
          <h2 className="card-title">📱 Get new phone contacts here automatically</h2>
          <p className="small muted">
            Add someone on your iPhone and they show up here the next time you open the app, ready for notes and tags. No
            exporting. A website can't read your phone directly, so this goes through your Gmail account:
          </p>
          {howTo}
          <div className="row-gap">
            <button className="btn primary" disabled={!hasGoogle || busy} onClick={() => void autoContacts.setEnabled(true)}>
              {busy ? 'Checking…' : 'Turn on'}
            </button>
          </div>
        </section>
      )}
      {auto.enabled && open && (
        <div className="card pad small">
          {howTo}
          <p className="muted">
            Contacts saved to iCloud instead of Gmail can't be read by a website. To bring those in, export them from the Contacts
            app on <Link to="/sync">Import & settings</Link>. Google sign-in lasts an hour, so after that a bar at the top asks
            you to tap <b>Check now</b> once a day.
          </p>
        </div>
      )}
    </>
  );
}
