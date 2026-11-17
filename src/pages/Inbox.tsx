import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Chips, Empty, PageHead, PersonRow, SourceIcon } from '@/components/ui';
import { listPeople, updatePerson, type Person } from '@/db/people';
import { useQuery, useStore } from '@/lib/store';

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
