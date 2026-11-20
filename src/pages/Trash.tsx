import { useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Empty, PageHead, Pager } from '@/components/ui';
import { listTrash, purgeTrash, restoreFromTrash, TRASH_DAYS } from '@/db/trash';
import { formatDate } from '@/lib/dates';
import { useQuery, useStore } from '@/lib/store';

const PAGE = 50;

export function Trash() {
  const { db, bump } = useStore();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<{ text: string; id?: number } | null>(null);
  const items = useQuery(() => listTrash(db));
  if (!items) return null;

  const q = search.trim().toLowerCase();
  const shown = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
  const pg = Math.min(page, Math.max(0, Math.ceil(shown.length / PAGE) - 1));

  const restore = async (ids: number[], label: string) => {
    const n = await restoreFromTrash(db, ids);
    setNotice({ text: n ? `Restored ${label}.` : `${label} is already back.`, id: ids.length === 1 ? ids[0] : undefined });
    bump();
  };
  const forget = async (ids: number[] | undefined, label: string) => {
    if (!confirm(`Delete ${label} for good? This can't be undone.`)) return;
    await purgeTrash(db, ids);
    setNotice({ text: `Deleted ${label} for good.` });
    bump();
  };

  return (
    <div className="page trash-page">
      <PageHead
        title="Recycle bin"
        sub={`People you deleted in the last ${TRASH_DAYS} days, with their notes, tags, sources and scores. Restore puts them back exactly as they were. After ${TRASH_DAYS} days they're gone for good.`}
      >
        {items.length > 0 && (
          <button type="button" className="btn danger small" onClick={() => forget(undefined, `all ${items.length.toLocaleString()} ${items.length === 1 ? 'person' : 'people'} in the bin`)}>
            Empty bin
          </button>
        )}
      </PageHead>
      {notice && (
        <p className="notice" role="status">
          ✓ {notice.text} {notice.id !== undefined && <Link to={`/person/${notice.id}`}>Open →</Link>}
        </p>
      )}

      {items.length === 0 ? (
        <Empty>The bin is empty. People you delete show up here for {TRASH_DAYS} days.</Empty>
      ) : (
        <>
          <input className="input" type="search" placeholder="Search the bin…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} aria-label="Search the bin" />
          {shown.length === 0 ? (
            <Empty>No matches.</Empty>
          ) : (
            <ul className="list card">
              {shown.slice(pg * PAGE, (pg + 1) * PAGE).map((i) => (
                <li key={i.person_id} className="person-row">
                  <span className="person-link">
                    <Avatar name={i.name} photo={i.photo} size={32} />
                    <span className="person-text">
                      <span className="person-name">{i.name}</span>
                      <span className="person-sub">
                        Deleted {formatDate(i.deleted_at.slice(0, 10))} · {i.daysLeft === 0 ? 'gone after today' : `${i.daysLeft} ${i.daysLeft === 1 ? 'day' : 'days'} left`}
                      </span>
                    </span>
                  </span>
                  <div className="person-right">
                    <button type="button" className="btn secondary small" onClick={() => restore([i.person_id], i.name)}>
                      ↩ Restore
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => forget([i.person_id], i.name)}>
                      Delete for good
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Pager page={pg} pageSize={PAGE} count={shown.length} onChange={setPage} />
        </>
      )}
    </div>
  );
}
