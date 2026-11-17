import { useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Empty, PageHead, Pager } from '@/components/ui';
import { applyNameSuggestions, AUTO_NAMES_KEY, keepName, nameReviewList, renamePerson, type NameRow } from '@/db/names';
import { getSetting, setSetting } from '@/db/people';
import { REASON_LABELS } from '@/lib/names';
import { useQuery, useStore } from '@/lib/store';

const PAGE = 50;
type Filter = 'suggested' | 'sure' | 'none' | 'all';

export function Names() {
  const { db, bump } = useStore();
  const [filter, setFilter] = useState<Filter>('suggested');
  const [page, setPage] = useState(0);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const data = useQuery(async () => ({ rows: await nameReviewList(db), auto: (await getSetting(db, AUTO_NAMES_KEY)) !== '0' }));
  if (!data) return null;

  const { rows } = data;
  const sure = rows.filter((r) => r.suggestion?.confidence === 'high');
  const suggested = rows.filter((r) => r.suggestion);
  const none = rows.filter((r) => !r.suggestion);
  const shown = filter === 'sure' ? sure : filter === 'suggested' ? suggested : filter === 'none' ? none : rows;
  const pg = Math.min(page, Math.max(0, Math.ceil(shown.length / PAGE) - 1));

  const value = (r: NameRow) => edits[r.id] ?? r.suggestion?.name ?? '';
  const done = (msg: string) => {
    setNotice(msg);
    bump();
  };
  const save = async (r: NameRow) => {
    const v = value(r).trim();
    if (!v) return;
    await renamePerson(db, r.id, v);
    done(`Renamed “${r.name}” to “${v}”.`);
  };
  const keep = async (r: NameRow) => {
    await keepName(db, r.id);
    done(`Kept “${r.name}” as is.`);
  };
  const applyAll = async (all: boolean) => {
    const { fixed } = await applyNameSuggestions(db, { all });
    done(`Applied ${fixed.toLocaleString()} ${fixed === 1 ? 'suggestion' : 'suggestions'}.`);
  };
  /** Save every name on this page: your edits, or the suggestion where you didn't type one. */
  const savePage = async (list: NameRow[]) => {
    let n = 0;
    await db.withTransactionAsync(async () => {
      for (const r of list) {
        const v = value(r).trim();
        if (v && v !== r.name) {
          await renamePerson(db, r.id, v);
          n++;
        }
      }
    });
    done(`Saved ${n} ${n === 1 ? 'name' : 'names'}.`);
  };

  const tabs: { key: Filter; label: string; n: number }[] = [
    { key: 'suggested', label: 'Has a suggestion', n: suggested.length },
    { key: 'sure', label: 'Sure fixes', n: sure.length },
    { key: 'none', label: 'Needs you', n: none.length },
    { key: 'all', label: 'All', n: rows.length },
  ];
  const pageRows = shown.slice(pg * PAGE, (pg + 1) * PAGE);

  return (
    <div className="page names-page">
      <PageHead title="Clean up names" sub="Make everyone “First Last”. Instagram only gives usernames, so these are guesses from the names people use in your chats and from their usernames. Check them, edit any that are wrong, and save." />

      {notice && <p className="notice" role="status">✓ {notice}</p>}

      <section className="card pad stack">
        <div className="row-gap">
          <button type="button" className="btn primary" disabled={!sure.length} onClick={() => applyAll(false)}>
            Apply {sure.length.toLocaleString()} sure {sure.length === 1 ? 'fix' : 'fixes'}
          </button>
          <button type="button" className="btn secondary" disabled={!suggested.length} onClick={() => applyAll(true)}>
            Apply all {suggested.length.toLocaleString()} suggestions
          </button>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={data.auto}
            onChange={async (e) => {
              await setSetting(db, AUTO_NAMES_KEY, e.target.checked ? '1' : '0');
              bump();
            }}
          />
          Apply sure fixes automatically after every import
        </label>
        <p className="muted small">
          “Sure” means the name came from your chats, only needed capitals fixed, or the username clearly splits into a known first and last name (john.smith_99, jackiezhang26). Guesses like
          “zongyundeng → Zongyun Deng” are left for you to check. Names you type yourself are never changed.
        </p>
      </section>

      {rows.length === 0 ? (
        <Empty>
          Everyone has a proper name. 🎉 <Link to="/people">Back to People</Link>
        </Empty>
      ) : (
        <>
          <div className="chips" role="tablist" aria-label="Show">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={filter === t.key} className={`chip${filter === t.key ? ' active' : ''}`} onClick={() => { setFilter(t.key); setPage(0); }}>
                {t.label} · {t.n.toLocaleString()}
              </button>
            ))}
          </div>

          {pageRows.length === 0 ? (
            <Empty>Nothing here.</Empty>
          ) : (
            <ul className="list card names-list">
              {pageRows.map((r) => (
                <li key={r.id} className="name-row">
                  <Link to={`/person/${r.id}`} className="name-current" title="Open their page">
                    <Avatar name={r.name} photo={r.photo} size={36} />
                    <span className="person-text">
                      <span className="person-name">{r.name}</span>
                      <span className="person-sub">
                        {r.handles.filter((h) => h.toLowerCase() !== `@${r.name.toLowerCase()}`).slice(0, 2).join(' · ') ||
                          (r.suggestion ? '' : 'No guess. Type their name')}
                      </span>
                    </span>
                  </Link>
                  <span className="name-arrow" aria-hidden>→</span>
                  <form
                    className="name-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      save(r);
                    }}
                  >
                    <input
                      className={`input${r.suggestion && edits[r.id] === undefined ? ' suggested' : ''}`}
                      value={value(r)}
                      placeholder="First Last"
                      aria-label={`New name for ${r.name}`}
                      onChange={(e) => setEdits((m) => ({ ...m, [r.id]: e.target.value }))}
                    />
                    {r.suggestion && <span className={`name-reason ${r.suggestion.confidence}`}>{REASON_LABELS[r.suggestion.reason]}</span>}
                    <div className="row-gap name-actions">
                      <button type="submit" className="btn secondary small" disabled={!value(r).trim()}>
                        Save
                      </button>
                      <button type="button" className="btn ghost small" onClick={() => keep(r)}>
                        Keep as is
                      </button>
                    </div>
                  </form>
                </li>
              ))}
            </ul>
          )}
          {pageRows.length > 0 && (
            <button type="button" className="btn primary" onClick={() => savePage(pageRows)}>
              Save all {pageRows.length} on this page
            </button>
          )}
          <Pager page={pg} pageSize={PAGE} count={shown.length} onChange={setPage} />
        </>
      )}
    </div>
  );
}
