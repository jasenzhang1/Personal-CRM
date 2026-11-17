import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Avatar, Chips, Closeness, ScoreBadge, SourceBadge, TagInput } from '@/components/ui';
import {
  addStageNote,
  allTags,
  getTags,
  setTags,
  createPerson,
  deletePerson,
  getPerson,
  getSources,
  getStageEvents,
  listPeople,
  setStage,
  updatePerson,
  type Person,
  type PersonPatch,
  type SourceRow,
  type StageEvent,
} from '@/db/people';
import { CIRCLES, circleInfo, CLOSENESS_LABELS, FOLLOW_UPS, PRIORITIES, STAGES, stageInfo, type Circle, type Stage } from '@/lib/constants';
import { formatBirthday, formatDate, isoDate, isValidBirthday } from '@/lib/dates';
import { shrinkImage } from '@/lib/image';
import { inferCircle } from '@/lib/relationship';
import { activitySummary, loadScores, logInteraction, removeRanking, setPlacement } from '@/db/ranking';
import { describeScoreInfo, type ScoreInfo } from '@/lib/ranking';
import { useQuery, useStore } from '@/lib/store';

type Form = {
  name: string; phone: string; email: string; bMonth: string; bDay: string; bYear: string; company: string; title: string;
  how_met: string; met_on: string; notes: string; closeness: number; follow_up: string; last_contacted: string;
  priority: string | null; deal_value: string; next_step: string; next_step_on: string;
  circle: Circle | null; photo: string | null; tags: string[];
};

const EMPTY: Form = {
  name: '', phone: '', email: '', bMonth: '', bDay: '', bYear: '', company: '', title: '', how_met: '', met_on: '',
  notes: '', closeness: 0, follow_up: 'none', last_contacted: '', priority: null, deal_value: '', next_step: '', next_step_on: '',
  circle: null, photo: null, tags: [],
};

function splitBirthday(b: string | null) {
  if (!b) return { bMonth: '', bDay: '', bYear: '' };
  const md = b.length === 10 ? b.slice(5) : b;
  return { bMonth: String(Number(md.slice(0, 2))), bDay: String(Number(md.slice(3, 5))), bYear: b.length === 10 ? b.slice(0, 4) : '' };
}

const toForm = (p: Person): Form => ({
  name: p.name, phone: p.phone ?? '', email: p.email ?? '', ...splitBirthday(p.birthday), company: p.company ?? '',
  title: p.title ?? '', how_met: p.how_met ?? '', met_on: p.met_on ?? '', notes: p.notes ?? '', closeness: p.closeness,
  follow_up: p.follow_up, last_contacted: p.last_contacted ?? '', priority: p.priority,
  deal_value: p.deal_value != null ? String(p.deal_value) : '', next_step: p.next_step ?? '', next_step_on: p.next_step_on ?? '',
  circle: p.circle, photo: p.photo, tags: [],
});

const blank = (s: string) => (s.trim() ? s.trim() : null);
const pad2 = (s: string) => s.padStart(2, '0');
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'long' }));

export function PersonPage() {
  const { id: idParam } = useParams();
  const [search] = useSearchParams();
  const queue = search.get('queue') as 'new' | 'backlog' | null;
  const isNew = idParam === 'new';
  const id = isNew ? null : Number(idParam);
  const navigate = useNavigate();
  const { db, bump, proMode } = useStore();

  const [person, setPerson] = useState<Person | null>(null);
  const [missing, setMissing] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [events, setEvents] = useState<StageEvent[]>([]);
  const [stage, setStageLocal] = useState<Stage | null>((search.get('stage') as Stage) ?? null);
  const [note, setNote] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setError(null);
    if (id === null) {
      setPerson(null);
      setForm(EMPTY);
      return;
    }
    (async () => {
      const p = await getPerson(db, id);
      if (!p) return setMissing(true);
      setPerson(p);
      setForm({ ...toForm(p), tags: await getTags(db, id) });
      setStageLocal(p.stage);
      setSources(await getSources(db, id));
      setEvents(await getStageEvents(db, id));
      if (queue) {
        const r = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM people WHERE status = ?', queue);
        setRemaining(r?.n ?? 0);
      }
    })();
  }, [db, id, queue]);

  const tagSuggestions = useQuery(() => allTags(db), []);
  const standing = useQuery(async () => {
    if (id === null || !person) return null;
    // Rank among everyone, so "#3 of 240" means the same thing here as on the Rank page.
    const all = await listPeople(db, { status: ['new', 'backlog', 'reviewed'] });
    const scores = await loadScores(db, all.some((p) => p.id === id) ? all : [...all, person]);
    const withScore = [...scores.values()].filter((s) => s.score > 0).length;
    return { s: scores.get(id)!, withScore, activity: await activitySummary(db, id) };
  }, [id, person]);
  const [logMinutes, setLogMinutes] = useState('60');
  const [logDay, setLogDay] = useState(isoDate());
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const inQueue = !!queue && (person?.status === 'new' || person?.status === 'backlog');
  const showPro = proMode || !!stage;

  const birthday = (): string | null | 'invalid' => {
    if (!form.bMonth && !form.bDay && !form.bYear) return null;
    if (!form.bMonth || !form.bDay) return 'invalid';
    const md = `${pad2(form.bMonth)}-${pad2(form.bDay)}`;
    const b = form.bYear.trim() ? `${form.bYear.trim()}-${md}` : md;
    return isValidBirthday(b) ? b : 'invalid';
  };

  const save = async (andNext: boolean) => {
    if (!form.name.trim()) return setError('Please enter a name.');
    const b = birthday();
    if (b === 'invalid') return setError("That birthday isn't a real date.");
    const value = form.deal_value.trim() ? Number(form.deal_value.replace(/[$,]/g, '')) : null;
    if (value !== null && Number.isNaN(value)) return setError('Deal value should be a number.');
    setError(null);
    const patch: PersonPatch = {
      name: form.name.trim(), phone: blank(form.phone), email: blank(form.email), birthday: b,
      company: blank(form.company), title: blank(form.title), how_met: blank(form.how_met), met_on: blank(form.met_on),
      notes: blank(form.notes), closeness: form.closeness, follow_up: form.follow_up, last_contacted: blank(form.last_contacted),
      priority: form.priority, deal_value: value, next_step: blank(form.next_step), next_step_on: blank(form.next_step_on),
      circle: form.circle, photo: form.photo, status: 'reviewed',
    };
    let savedId = id;
    if (savedId === null) {
      savedId = await createPerson(db, { ...patch, name: patch.name! });
      if (stage) await setStage(db, savedId, stage);
    } else {
      await updatePerson(db, savedId, patch);
    }
    await setTags(db, savedId, form.tags);
    bump();
    if (andNext && queue) return goNext(savedId);
    if (isNew) return navigate(`/person/${savedId}`, { replace: true });
    setPerson((p) => (p ? { ...p, status: 'reviewed' } : p));
    setSavedAt(Date.now());
  };

  const goNext = async (currentId: number) => {
    const next = await db.getFirstAsync<{ id: number }>(
      'SELECT id FROM people WHERE status = ? AND id != ? ORDER BY name COLLATE NOCASE LIMIT 1',
      queue, currentId,
    );
    if (next) navigate(`/person/${next.id}?queue=${queue}`, { replace: true });
    else {
      alert('All caught up 🎉 Everyone in this list has been filled in.');
      navigate('/');
    }
  };

  const skip = async () => {
    if (id === null) return;
    await updatePerson(db, id, { status: 'archived' });
    bump();
    goNext(id);
  };

  const changeStage = async (s: Stage | null) => {
    setStageLocal(s);
    if (id !== null) {
      await setStage(db, id, s);
      setEvents(await getStageEvents(db, id));
      bump();
    }
  };

  const logNote = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    if (id === null || !note.trim()) return;
    await addStageNote(db, id, note.trim());
    setNote('');
    setEvents(await getStageEvents(db, id));
  };

  const remove = async () => {
    if (!confirm(`Delete ${form.name} and everything you wrote about them? This can't be undone.`)) return;
    await deletePerson(db, id!);
    bump();
    navigate(-1);
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      set('photo', await shrinkImage(file, 160));
    } catch {
      setError("Couldn't read that image. Try a JPEG or PNG.");
    }
  };

  const sourceKinds = [...new Set(sources.map((s) => s.source))];
  const guess = inferCircle(sourceKinds, !!stage);
  const igHandle = sources.find((s) => s.source === 'instagram')?.handle?.replace(/^@/, '');

  if (missing) return <div className="page"><p className="empty">This person no longer exists. <Link to="/people">Back to People</Link></p></div>;

  const b = birthday();
  const days = form.bMonth ? new Date(2000, Number(form.bMonth), 0).getDate() : 31;

  return (
    <form
      className="page person-page"
      onSubmit={(e) => {
        e.preventDefault();
        save(inQueue);
      }}
    >
      <div className="person-bar">
        <button type="button" className="btn ghost" onClick={() => navigate(-1)}>
          ← Back
        </button>
        <span className="muted">{inQueue && remaining ? `${remaining} left to fill in` : savedAt ? 'Saved ✓' : ''}</span>
        <span className="row-gap">
          {inQueue && (
            <button type="button" className="btn ghost" onClick={skip}>
              Skip
            </button>
          )}
          <button type="submit" className="btn primary">
            {inQueue ? 'Save & next →' : 'Save'}
          </button>
        </span>
      </div>
      {error && <p className="notice err" role="alert">{error}</p>}

      <header className="person-head">
        <div className="photo-edit">
          <label title="Change photo">
            <Avatar name={form.name || '?'} photo={form.photo} size={72} />
            <span className="photo-edit-badge" aria-hidden>
              📷
            </span>
            <input type="file" accept="image/*" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} aria-label="Change photo" />
          </label>
          {form.photo && (
            <button type="button" className="link-btn small" onClick={() => set('photo', null)}>
              Remove
            </button>
          )}
        </div>
        <div className="grow">
          <input className="name-input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Name" aria-label="Name" autoFocus={isNew} />
          <div className="badges">
            {sources.map((s) => <SourceBadge key={s.id} source={s.source} />)}
            {sources.filter((s) => s.handle).map((s) =>
              s.source === 'instagram' ? (
                <a key={`h${s.id}`} href={`https://www.instagram.com/${s.handle!.replace(/^@/, '')}/`} target="_blank" rel="noreferrer" className="small">{s.handle}</a>
              ) : s.handle!.startsWith('http') ? (
                <a key={`h${s.id}`} href={s.handle!} target="_blank" rel="noreferrer" className="small">{s.handle!.replace(/^https?:\/\/(www\.)?/, '')}</a>
              ) : (
                <span key={`h${s.id}`} className="small muted">{s.handle}</span>
              ),
            )}
          </div>
        </div>
      </header>
      {inQueue && <p className="notice">New connection! Jot down how you met while it's fresh.</p>}
      {!form.photo && igHandle && (
        <p className="small muted">
          No photo yet. Open{' '}
          <a href={`https://www.instagram.com/${igHandle}/`} target="_blank" rel="noreferrer">
            their Instagram ↗
          </a>
          , save their profile picture, then tap the 📷 above.
        </p>
      )}

      <div className="person-grid">
        <div className="stack">
          <Card title="How you met">
            <textarea className="input" rows={3} value={form.how_met} onChange={(e) => set('how_met', e.target.value)}
              placeholder="e.g. Sat next to them at Dana's wedding; intro'd by Priya at a hackathon" autoFocus={inQueue} />
            <Field label="When you met">
              <DateInput value={form.met_on} onChange={(v) => set('met_on', v)} />
            </Field>
          </Card>
          <Card title="Things to remember">
            <textarea className="input" rows={6} value={form.notes} onChange={(e) => set('notes', e.target.value)}
              placeholder="Kids' names, favorite food, what they're working on, what you talked about…" />
          </Card>
          <Card title="Relationship">
            <Field label={`Closeness · ${CLOSENESS_LABELS[form.closeness]}`}>
              <Closeness value={form.closeness} onChange={(n) => set('closeness', n)} size={28} />
            </Field>

            <Field label="How often do you want to follow up?">
              <Chips label="Follow-up" options={FOLLOW_UPS.map((f) => ({ key: f.key as string, label: f.label }))} value={form.follow_up} onChange={(v) => set('follow_up', v)} />
            </Field>
            <Field label="Last contacted">
              <DateInput value={form.last_contacted} onChange={(v) => set('last_contacted', v)} todayLabel="Talked today" />
            </Field>
            <Field label={`Birthday${b && b !== 'invalid' ? ` · ${formatBirthday(b)}` : ''}`}>
              <div className="row-gap">
                <select className="input" value={form.bMonth} onChange={(e) => set('bMonth', e.target.value)} aria-label="Birthday month">
                  <option value="">Month</option>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select className="input" value={form.bDay} onChange={(e) => set('bDay', e.target.value)} aria-label="Birthday day">
                  <option value="">Day</option>
                  {Array.from({ length: days }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                </select>
                <input className="input year" inputMode="numeric" maxLength={4} placeholder="Year (optional)" value={form.bYear}
                  onChange={(e) => set('bYear', e.target.value.replace(/\D/g, ''))} aria-label="Birthday year" />
              </div>
            </Field>
          </Card>
        </div>

        <div className="stack">
          {id !== null && standing && (
            <Card title="Closeness score">
              <div className="row-gap">
                <ScoreBadge score={standing.s.score} guess={!standing.s.placed} />
                <ScoreRankText s={standing.s} of={standing.withScore} />
                <Link className="btn secondary small" to={`/rank?person=${id}`}>
                  {standing.s.placed ? 'Re-rank' : '🏆 Rank them'}
                </Link>
              </div>
              <div className="row-gap">
                {standing.s.score > 0 && (
                  <button type="button" className="btn ghost small" onClick={async () => { await setPlacement(db, id, 0, standing.s.activity); bump(); }}>
                    Not close anymore (set to 0)
                  </button>
                )}
                {standing.s.placed && (
                  <button type="button" className="btn ghost small" onClick={async () => { await removeRanking(db, id); bump(); }}>
                    Go back to the activity guess
                  </button>
                )}
              </div>
              <span className="small muted">{describeScoreInfo(standing.s)}</span>
              <ActivityLine a={standing.activity} />
              <Field label="Log a call or hangout">
                <div className="row-gap">
                  <select className="input" value={logMinutes} onChange={(e) => setLogMinutes(e.target.value)} aria-label="How long">
                    <option value="15">15 min</option>
                    <option value="30">30 min</option>
                    <option value="60">1 hour</option>
                    <option value="120">2 hours</option>
                    <option value="240">Half a day</option>
                    <option value="480">All day</option>
                  </select>
                  <input className="input grow" type="date" value={logDay} max={isoDate()} onChange={(e) => setLogDay(e.target.value)} aria-label="When" />
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={async () => {
                      await logInteraction(db, id, logDay || isoDate(), Number(logMinutes));
                      if (!form.last_contacted || form.last_contacted < logDay) set('last_contacted', logDay);
                      bump();
                    }}
                  >
                    Log it
                  </button>
                </div>
              </Field>
            </Card>
          )}
          <Card title="Type & tags">
            <Field label={form.circle || !guess ? 'Personal or professional?' : `Personal or professional? · guessed ${circleInfo(guess)!.label}`}>
              <Chips
                label="Personal or professional"
                options={CIRCLES.map((c) => ({ key: c.key as string, label: c.label, color: c.color }))}
                value={form.circle}
                onChange={(v) => set('circle', form.circle === v ? null : (v as Circle))}
              />
            </Field>
            <Field label="Tags">
              <TagInput value={form.tags} onChange={(t) => set('tags', t)} suggestions={(tagSuggestions ?? []).map((t) => t.tag)} />
            </Field>
          </Card>
          <Card title="Contact">
            <input className="input" type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="Phone" aria-label="Phone" />
            <input className="input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="Email" aria-label="Email" />
            <input className="input" value={form.company} onChange={(e) => set('company', e.target.value)} placeholder="Company" aria-label="Company" />
            <input className="input" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Job title" aria-label="Job title" />
          </Card>

          {showPro ? (
            <Card title="Pipeline">
              <Field label="Stage">
                <Chips label="Stage" options={STAGES.map((s) => ({ key: s.key as string, label: s.label, color: s.color }))} value={stage} onChange={(v) => changeStage(v as Stage)} />
                {stage && <button type="button" className="link-btn small" onClick={() => changeStage(null)}>Remove from pipeline</button>}
              </Field>
              <Field label="Priority">
                <Chips label="Priority" options={PRIORITIES.map((p) => ({ key: p.key as string, label: p.label, color: p.color }))} value={form.priority}
                  onChange={(v) => set('priority', form.priority === v ? null : v)} />
              </Field>
              <Field label="Deal value ($)">
                <input className="input" inputMode="decimal" value={form.deal_value} onChange={(e) => set('deal_value', e.target.value)} placeholder="e.g. 5000" />
              </Field>
              <Field label="Next step">
                <input className="input" value={form.next_step} onChange={(e) => set('next_step', e.target.value)} placeholder="e.g. Send proposal deck" />
                <DateInput value={form.next_step_on} onChange={(v) => set('next_step_on', v)} />
              </Field>
              {id !== null && (
                <Field label="Lifecycle">
                  <div className="row-gap">
                    <input className="input grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Log an update (call, email, meeting…)"
                      onKeyDown={(e) => e.key === 'Enter' && logNote(e)} />
                    <button type="button" className="btn secondary" onClick={() => logNote()}>Log</button>
                  </div>
                  <Timeline events={events} createdAt={person?.created_at} />
                </Field>
              )}
            </Card>
          ) : (
            id !== null && (
              <button type="button" className="btn secondary" onClick={() => changeStage('lead')}>
                Track as a lead / potential client
              </button>
            )
          )}

          {id !== null && (
            <button type="button" className="btn danger" onClick={remove}>
              Delete person
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card pad stack">
      <h2 className="card-title">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
    </div>
  );
}

function DateInput({ value, onChange, todayLabel = 'Today' }: { value: string; onChange: (v: string) => void; todayLabel?: string }) {
  return (
    <div className="row-gap">
      <input className="input grow" type="date" value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="btn secondary" onClick={() => onChange(isoDate())}>{todayLabel}</button>
    </div>
  );
}

function Timeline({ events, createdAt }: { events: StageEvent[]; createdAt?: string }) {
  return (
    <ol className="timeline">
      {events.map((e) => {
        const to = stageInfo(e.to_stage);
        const from = stageInfo(e.from_stage);
        const isMove = e.from_stage !== e.to_stage;
        return (
          <li key={e.id} style={{ ['--dot' as string]: isMove ? to?.color ?? 'var(--muted)' : 'var(--border-strong)' }}>
            <div>
              {isMove ? (to ? (from ? `${from.label} → ${to.label}` : `Added to pipeline as ${to.label}`) : 'Removed from pipeline') : e.note}
            </div>
            {isMove && e.note && <div className="muted">{e.note}</div>}
            <time className="muted small">{new Date(e.at).toLocaleString()}</time>
          </li>
        );
      })}
      {createdAt && <li className="muted small" style={{ ['--dot' as string]: 'var(--border-strong)' }}>First added {formatDate(createdAt.slice(0, 10))}</li>}
    </ol>
  );
}

function ActivityLine({ a }: { a: import('@/db/ranking').ActivitySummary }) {
  if (!a.days.length) return <span className="small muted">No chats or calls imported yet. Drop your Instagram, Facebook or Discord export (with Messages) on the Import page, or log a hangout below.</span>;
  const dur = (sec: number) => (sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : `${Math.round(sec / 60)} min`);
  const recent = [a.messages90 && `${a.messages90.toLocaleString()} messages`, a.calls90 && `${a.calls90} ${a.calls90 === 1 ? 'call / hangout' : 'calls / hangouts'} (${dur(a.callSeconds90)})`].filter(Boolean).join(', ');
  return (
    <span className="small">
      <strong>Last 90 days:</strong> {recent || 'quiet'}. <span className="muted">All time: {a.messagesAll.toLocaleString()} messages{a.callsAll ? `, ${a.callsAll} ${a.callsAll === 1 ? 'call / hangout' : 'calls / hangouts'} (${dur(a.callSecondsAll)})` : ''}{a.lastDay ? ` · last ${formatDate(a.lastDay)}` : ''}.</span>
    </span>
  );
}

function ScoreRankText({ s, of }: { s: ScoreInfo; of: number }) {
  if (s.score <= 0) return <span className="small">{s.placed ? 'Not close right now' : 'No score yet'}</span>;
  return <span className="small">#{s.rank} of {of}{s.placed ? '' : ' · guessed'}</span>;
}
