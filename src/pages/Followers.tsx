import { useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Empty, PageHead, Pager, instagramUrl } from '@/components/ui';
import { followExportDates, listFollowAccounts, listFollowEvents, type FollowAccount, type FollowEvent } from '@/db/followers';
import { setArchived } from '@/db/people';
import { formatDate } from '@/lib/dates';
import { useQuery, useStore } from '@/lib/store';

const PAGE = 50;
type Tab = 'notBack' | 'fans' | 'unfollowed' | 'new' | 'youUnfollowed';

export function Followers() {
  const { db, bump } = useStore();
  const [tab, setTab] = useState<Tab>('notBack');
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [hideArchived, setHideArchived] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const data = useQuery(async () => ({ accounts: await listFollowAccounts(db), events: await listFollowEvents(db), dates: await followExportDates(db) }));
  if (!data) return null;

  const { accounts, events, dates } = data;
  const followers = accounts.filter((a) => a.follows_me);
  const following = accounts.filter((a) => a.i_follow);
  const mutual = accounts.filter((a) => a.follows_me && a.i_follow).length;
  const byDate = (key: 'follows_me_since' | 'i_follow_since') => (x: FollowAccount, y: FollowAccount) => (y[key] ?? '').localeCompare(x[key] ?? '');
  const lists: Record<Tab, (FollowAccount | FollowEvent)[]> = {
    notBack: following.filter((a) => !a.follows_me).sort(byDate('i_follow_since')),
    fans: followers.filter((a) => !a.i_follow).sort(byDate('follows_me_since')),
    unfollowed: events.filter((e) => e.kind === 'unfollowed_me'),
    new: events.filter((e) => e.kind === 'followed_me'),
    youUnfollowed: events.filter((e) => e.kind === 'i_unfollowed'),
  };
  const q = search.trim().toLowerCase().replace(/^@/, '');
  const visible = (rows: (FollowAccount | FollowEvent)[]) =>
    rows.filter((r) => (!hideArchived || r.status !== 'archived') && (!q || r.username.includes(q) || (r.name ?? '').toLowerCase().includes(q)));
  const shown = visible(lists[tab]);
  const pg = Math.min(page, Math.max(0, Math.ceil(shown.length / PAGE) - 1));
  const pageRows = shown.slice(pg * PAGE, (pg + 1) * PAGE);
  const hasBaselineOnly = !!dates.followers && !events.some((e) => e.kind === 'unfollowed_me' || e.kind === 'followed_me');

  const tabs: { key: Tab; label: string; n: number }[] = [
    { key: 'notBack', label: 'Don’t follow you back', n: visible(lists.notBack).length },
    { key: 'fans', label: 'You don’t follow back', n: visible(lists.fans).length },
    { key: 'unfollowed', label: 'Unfollowed you', n: visible(lists.unfollowed).length },
    { key: 'new', label: 'New followers', n: visible(lists.new).length },
    { key: 'youUnfollowed', label: 'You unfollowed', n: visible(lists.youUnfollowed).length },
  ];

  const archiveRows = async (rows: (FollowAccount | FollowEvent)[]) => {
    const ids = [...new Set(rows.filter((r) => r.person_id && r.status !== 'archived').map((r) => r.person_id!))];
    if (!ids.length) return;
    if (!confirm(`Archive ${ids.length.toLocaleString()} ${ids.length === 1 ? 'person' : 'people'}? They'll be hidden from People and Rank. You can unarchive any time.`)) return;
    await setArchived(db, ids, true);
    setNotice(`Archived ${ids.length.toLocaleString()}.`);
    bump();
  };

  return (
    <div className="page followers-page">
      <PageHead
        title="Instagram followers"
        sub={
          dates.followers
            ? `${followers.length.toLocaleString()} followers · ${following.length.toLocaleString()} following · ${mutual.toLocaleString()} mutual · as of your export from ${formatDate(dates.followers)}`
            : undefined
        }
      />
      {notice && <p className="notice" role="status">✓ {notice}</p>}

      {!accounts.length ? (
        <Empty>
          No Instagram followers yet. Drop your Instagram export (the .zip) on the <Link to="/sync">Import page</Link>.
        </Empty>
      ) : (
        <>
          <div className="chips" role="tablist" aria-label="Show">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`chip${tab === t.key ? ' active' : ''}`} onClick={() => { setTab(t.key); setPage(0); }}>
                {t.label} · {t.n.toLocaleString()}
              </button>
            ))}
          </div>
          <div className="row-gap">
            <input className="input grow" type="search" placeholder="Search name or @username…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} aria-label="Search followers" />
            <label className="check">
              <input type="checkbox" checked={hideArchived} onChange={(e) => setHideArchived(e.target.checked)} />
              Hide archived
            </label>
          </div>

          <TabNote tab={tab} baselineOnly={hasBaselineOnly} dates={dates} />

          {pageRows.length === 0 ? (
            <Empty>{q ? 'No matches.' : 'No one here.'}</Empty>
          ) : (
            <>
              <ul className="list card follow-list">
                {pageRows.map((r, i) => (
                  <FollowRow
                    key={`${r.username}:${'kind' in r ? r.kind + r.at : ''}:${i}`}
                    r={r}
                    tab={tab}
                    onArchive={async (archive) => {
                      await setArchived(db, [r.person_id!], archive);
                      setNotice(`${archive ? 'Archived' : 'Unarchived'} ${r.name ?? '@' + r.username}.`);
                      bump();
                    }}
                  />
                ))}
              </ul>
              {(tab === 'notBack' || tab === 'fans') && pageRows.some((r) => r.person_id && r.status !== 'archived') && (
                <button type="button" className="btn secondary" onClick={() => archiveRows(pageRows)}>
                  🗄 Archive everyone on this page
                </button>
              )}
            </>
          )}
          <Pager page={pg} pageSize={PAGE} count={shown.length} onChange={setPage} />
        </>
      )}
    </div>
  );
}

function TabNote({ tab, baselineOnly, dates }: { tab: Tab; baselineOnly: boolean; dates: { followers: string | null; following: string | null } }) {
  const text: Record<Tab, string> = {
    notBack: 'Accounts you follow that don’t follow you. Lots of these are celebrities, brands or clubs. Archive the ones that aren’t people you know.',
    fans: 'Accounts that follow you that you don’t follow back.',
    unfollowed: baselineOnly
      ? `Instagram doesn’t say who unfollowed you, so the app compares each export with the one before. Your export from ${formatDate(dates.followers)} is the starting point. Download a new export from Instagram in a few weeks and drop it on the Import page to see who unfollowed in between.`
      : 'People who followed you in an earlier export but not in a later one. Instagram doesn’t give the exact day, so it shows the window between the two exports.',
    new: baselineOnly ? 'New followers show up here once you import a newer export.' : 'People who started following you since an earlier export.',
    youUnfollowed: 'Accounts you unfollowed, from Instagram’s own list and from comparing exports.',
  };
  return <p className="small muted">{text[tab]}</p>;
}

function FollowRow({ r, tab, onArchive }: { r: FollowAccount | FollowEvent; tab: Tab; onArchive: (archive: boolean) => void }) {
  const label = r.name ?? r.display ?? r.username;
  const handle = r.display ?? r.username;
  const ev = 'kind' in r ? r : null;
  let when = '';
  if (ev?.kind === 'unfollowed_me') when = `Unfollowed you between ${formatDate(ev.after)} and ${formatDate(ev.at)}${r.follows_me ? ' · follows you again now' : ''}`;
  else if (ev?.kind === 'followed_me') when = `Followed you ${formatDate(ev.at)}`;
  else if (ev?.kind === 'i_unfollowed') when = ev.after ? `You unfollowed between ${formatDate(ev.after)} and ${formatDate(ev.at)}` : `You unfollowed ${formatDate(ev.at)}`;
  else if (tab === 'notBack' && r.i_follow_since) when = `You followed them ${formatDate(r.i_follow_since)}`;
  else if (tab === 'fans' && r.follows_me_since) when = `Followed you ${formatDate(r.follows_me_since)}`;
  return (
    <li className={`person-row${r.status === 'archived' ? ' dim' : ''}`}>
      {r.person_id ? (
        <Link to={`/person/${r.person_id}`} className="person-link">
          <Avatar name={label} photo={r.photo} size={36} />
          <span className="person-text">
            <span className="person-name">{label}</span>
            <span className="person-sub">{when}</span>
          </span>
        </Link>
      ) : (
        <span className="person-link">
          <Avatar name={label} size={36} />
          <span className="person-text">
            <span className="person-name">{label}</span>
            <span className="person-sub">{when}</span>
          </span>
        </span>
      )}
      <div className="person-right">
        <a className="btn ghost small" href={instagramUrl(handle)} target="_blank" rel="noreferrer" title="Open on Instagram">
          @{handle} ↗
        </a>
        {r.person_id && (
          <button type="button" className="btn ghost small" onClick={() => onArchive(r.status !== 'archived')}>
            {r.status === 'archived' ? 'Unarchive' : 'Archive'}
          </button>
        )}
      </div>
    </li>
  );
}
