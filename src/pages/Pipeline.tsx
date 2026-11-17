import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar, Chips, Empty, LabelMenu, Modal, PageHead } from '@/components/ui';
import { listPeople, listPipeline, setStage, updatePerson, type Person, type PersonPatch } from '@/db/people';
import { PRIORITIES, priorityInfo, STAGES, stageInfo, type Priority, type Stage } from '@/lib/constants';
import { daysBetween, parseIsoDate } from '@/lib/dates';
import { useQuery, useStore } from '@/lib/store';

const money = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `$${n}`;

type Menu = { anchor: HTMLElement; person: Person; field: 'stage' | 'priority' } | null;

export function Pipeline() {
  const { db, bump, proMode } = useStore();
  const rows = useQuery(() => listPipeline(db));
  const [view, setView] = useState<'table' | 'kanban'>(() => (localStorageGet('pipeline-view') as 'table' | 'kanban') ?? 'table');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ lost: true });
  const [menu, setMenu] = useState<Menu>(null);
  const [adding, setAdding] = useState<Stage | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const people = rows ?? [];
  const byStage = (s: Stage) => people.filter((p) => p.stage === s);
  const open = people.filter((p) => p.stage !== 'won' && p.stage !== 'lost');
  const openValue = open.reduce((a, p) => a + (p.deal_value ?? 0), 0);
  const wonValue = byStage('won').reduce((a, p) => a + (p.deal_value ?? 0), 0);
  const overdue = open.filter((p) => {
    const d = parseIsoDate(p.next_step_on);
    return d && daysBetween(new Date(), d) < 0;
  }).length;

  const save = async (p: Person, patch: PersonPatch) => {
    await updatePerson(db, p.id, patch);
    bump();
  };
  const move = async (id: number, stage: Stage | null) => {
    await setStage(db, id, stage);
    bump();
  };
  const pick = async (value: string | null) => {
    if (!menu) return;
    if (menu.field === 'stage') await move(menu.person.id, value as Stage | null);
    else await save(menu.person, { priority: value });
    setMenu(null);
  };
  const changeView = (v: 'table' | 'kanban') => {
    setView(v);
    localStorageSet('pipeline-view', v);
  };

  return (
    <div className="page page-wide">
      <PageHead title="Pipeline" sub="Leads and potential clients, from first touch to closed.">
        <button className="btn primary" onClick={() => setAdding('lead')}>
          + New lead
        </button>
      </PageHead>
      {!proMode && (
        <p className="notice">
          Professional mode is off, so this page is hidden from the menu. <Link to="/sync">Turn it on in Settings</Link>.
        </p>
      )}

      <div className="stats">
        <Stat label="Open leads" value={String(open.length)} />
        <Stat label="Pipeline value" value={money(openValue)} />
        <Stat label="Won" value={money(wonValue)} tone="good" />
        <Stat label="Overdue next steps" value={String(overdue)} tone={overdue ? 'bad' : undefined} />
      </div>
      {people.length > 0 && (
        <div className="battery" role="img" aria-label="People per stage">
          {STAGES.map((s) => {
            const n = byStage(s.key).length;
            return n ? <span key={s.key} style={{ flex: n, background: s.color }} title={`${s.label}: ${n}`} /> : null;
          })}
        </div>
      )}
      <Chips
        label="View"
        options={[
          { key: 'table', label: '▤ Table' },
          { key: 'kanban', label: '▥ Kanban' },
        ]}
        value={view}
        onChange={changeView}
      />

      {rows && people.length === 0 && (
        <Empty>Track potential clients from first touch to closed deal. Click “New lead” to add someone.</Empty>
      )}

      {view === 'table' ? (
        <div className="board">
          {STAGES.map((s) => {
            const items = byStage(s.key);
            const sum = items.reduce((a, p) => a + (p.deal_value ?? 0), 0);
            const isCollapsed = collapsed[s.key];
            return (
              <section key={s.key} className="group" style={{ ['--group' as string]: s.color }}>
                <button className="group-head" onClick={() => setCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))} aria-expanded={!isCollapsed}>
                  <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
                  <span className="group-title">{s.label}</span>
                  <span className="muted">
                    {items.length} {items.length === 1 ? 'person' : 'people'}
                    {sum ? ` · ${money(sum)}` : ''}
                  </span>
                </button>
                {!isCollapsed && items.length === 0 && (
                  <button className="link-btn empty-group" onClick={() => setAdding(s.key)}>
                    + Add someone to {s.label}
                  </button>
                )}
                {!isCollapsed && items.length > 0 && (
                  <div className="table-scroll">
                    <table className="board-table">
                      <thead>
                        <tr>
                          <th className="sticky-col">Person</th>
                          <th>Stage</th>
                          <th>Priority</th>
                          <th>Company</th>
                          <th>Value</th>
                          <th>Next step</th>
                          <th>Due</th>
                          <th>Last touch</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((p) => (
                          <BoardRow key={p.id} p={p} onMenu={(anchor, field) => setMenu({ anchor, person: p, field })} onSave={(patch) => save(p, patch)} />
                        ))}
                        <tr>
                          <td className="sticky-col add-cell" colSpan={1}>
                            <button className="link-btn" onClick={() => setAdding(s.key)}>
                              + Add
                            </button>
                          </td>
                          <td colSpan={7} />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <Kanban byStage={byStage} onMove={move} onAdd={setAdding} onMenu={(anchor, person) => setMenu({ anchor, person, field: 'stage' })} />
      )}

      <LabelMenu<string>
        anchor={menu?.anchor ?? null}
        title={menu ? `${menu.field === 'stage' ? 'Stage' : 'Priority'} · ${menu.person.name}` : undefined}
        options={menu?.field === 'priority' ? PRIORITIES : STAGES}
        current={menu ? (menu.field === 'stage' ? menu.person.stage : menu.person.priority) : null}
        clearLabel={menu?.field === 'stage' ? 'Remove from pipeline' : 'Clear priority'}
        onPick={pick}
        onClose={closeMenu}
      />
      <AddLead stage={adding} onClose={() => setAdding(null)} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** A text/number/date cell that edits in place and saves on blur or Enter. */
function EditCell({ value, type = 'text', placeholder, onSave, className }: {
  value: string;
  type?: 'text' | 'number' | 'date';
  placeholder?: string;
  onSave: (v: string) => void;
  className?: string;
}) {
  return (
    <input
      key={value /* reset when the saved value changes */}
      className={`cell-input ${className ?? ''}`}
      type={type}
      defaultValue={value}
      placeholder={placeholder}
      inputMode={type === 'number' ? 'decimal' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => e.currentTarget.value !== value && onSave(e.currentTarget.value)}
    />
  );
}

function BoardRow({ p, onMenu, onSave }: {
  p: Person;
  onMenu: (anchor: HTMLElement, field: 'stage' | 'priority') => void;
  onSave: (patch: PersonPatch) => void;
}) {
  const st = stageInfo(p.stage);
  const pr = priorityInfo(p.priority);
  const due = parseIsoDate(p.next_step_on);
  const closed = p.stage === 'won' || p.stage === 'lost';
  const dueDays = due && !closed ? daysBetween(new Date(), due) : null;
  const t = (s: string) => (s.trim() ? s.trim() : null);
  return (
    <tr>
      <td className="sticky-col">
        <Link to={`/person/${p.id}`} className="cell-person">
          <Avatar name={p.name} photo={p.photo} size={26} />
          <span>{p.name}</span>
        </Link>
      </td>
      <td className="pill-cell">
        <button className="pill" style={{ background: st?.color }} onClick={(e) => onMenu(e.currentTarget, 'stage')}>
          {st?.label ?? '—'}
        </button>
      </td>
      <td className="pill-cell">
        <button className="pill" style={{ background: pr?.color ?? 'var(--empty-pill)' }} onClick={(e) => onMenu(e.currentTarget, 'priority')}>
          {pr?.label ?? ''}
        </button>
      </td>
      <td><EditCell value={p.company ?? ''} onSave={(v) => onSave({ company: t(v) })} /></td>
      <td>
        <EditCell
          type="number"
          className="num"
          value={p.deal_value != null ? String(p.deal_value) : ''}
          placeholder="$"
          onSave={(v) => onSave({ deal_value: v.trim() && !Number.isNaN(Number(v)) ? Number(v) : null })}
        />
      </td>
      <td><EditCell value={p.next_step ?? ''} onSave={(v) => onSave({ next_step: t(v) })} /></td>
      <td className={dueDays !== null && dueDays < 0 ? 'overdue' : dueDays === 0 ? 'due-today' : undefined}>
        <EditCell type="date" value={p.next_step_on ?? ''} onSave={(v) => onSave({ next_step_on: t(v) })} />
      </td>
      <td><EditCell type="date" value={p.last_contacted ?? ''} onSave={(v) => onSave({ last_contacted: t(v) })} /></td>
    </tr>
  );
}

function Kanban({ byStage, onMove, onAdd, onMenu }: {
  byStage: (s: Stage) => Person[];
  onMove: (id: number, s: Stage) => void;
  onAdd: (s: Stage) => void;
  onMenu: (anchor: HTMLElement, p: Person) => void;
}) {
  const [over, setOver] = useState<Stage | null>(null);
  return (
    <div className="kanban">
      {STAGES.map((s) => (
        <section
          key={s.key}
          className={`k-col${over === s.key ? ' drop' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(s.key);
          }}
          onDragLeave={() => setOver((o) => (o === s.key ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            const id = Number(e.dataTransfer.getData('text/person-id'));
            if (id) onMove(id, s.key);
          }}
        >
          <header className="k-head" style={{ background: s.color }}>
            <span>{s.label}</span>
            <span>{byStage(s.key).length}</span>
          </header>
          <div className="k-cards">
            {byStage(s.key).map((p) => {
              const pr = priorityInfo(p.priority as Priority);
              return (
                <article
                  key={p.id}
                  className="k-card"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/person-id', String(p.id))}
                >
                  <Link to={`/person/${p.id}`} className="k-name">
                    <Avatar name={p.name} photo={p.photo} size={24} />
                    <span>{p.name}</span>
                  </Link>
                  {p.company && <div className="muted small">{p.company}</div>}
                  {p.next_step && <div className="small">→ {p.next_step}</div>}
                  <div className="k-foot">
                    <button className="pill pill-sm" style={{ background: s.color }} onClick={(e) => onMenu(e.currentTarget, p)} title="Change stage">
                      Move
                    </button>
                    {pr && <span className="small" style={{ color: pr.color, fontWeight: 600 }}>{pr.label}</span>}
                    <span className="small strong">{p.deal_value ? money(p.deal_value) : ''}</span>
                  </div>
                </article>
              );
            })}
            <button className="link-btn" onClick={() => onAdd(s.key)}>
              + Add
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}

/** Add an existing contact to the pipeline, or create a new lead. */
function AddLead({ stage, onClose }: { stage: Stage | null; onClose: () => void }) {
  const { db, bump } = useStore();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const results = useQuery(
    async () => (stage ? (await listPeople(db, { search: q, status: ['new', 'backlog', 'reviewed'] })).filter((p) => !p.stage).slice(0, 50) : []),
    [q, stage],
  );
  const choose = async (p: Person) => {
    await setStage(db, p.id, stage!);
    bump();
    setQ('');
    onClose();
  };
  return (
    <Modal open={!!stage} title={`Add to ${stageInfo(stage)?.label ?? ''}`} onClose={onClose}>
      <button className="btn primary block" onClick={() => navigate(`/person/new?stage=${stage}`)}>
        Create a new person
      </button>
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="…or search your contacts" autoFocus />
      <ul className="list pick-list">
        {(results ?? []).map((p) => (
          <li key={p.id}>
            <button className="pick-row" onClick={() => choose(p)}>
              <Avatar name={p.name} photo={p.photo} size={30} />
              <span className="person-text">
                <span className="person-name">{p.name}</span>
                {p.company && <span className="person-sub">{p.company}</span>}
              </span>
            </button>
          </li>
        ))}
        {results && results.length === 0 && <li className="muted pad">No matching contacts outside the pipeline.</li>}
      </ul>
    </Modal>
  );
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
