import { useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Empty, PageHead } from '@/components/ui';
import { listPeople, updatePerson, type PersonListRow } from '@/db/people';
import { loadScores } from '@/db/ranking';
import { birthDay, birthMonth, birthdaysIcs, turningAge } from '@/lib/birthdays';
import { daysUntilBirthday, formatBirthday, relativeDays } from '@/lib/dates';
import { useQuery, useStore } from '@/lib/store';

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'long' }));
const ACTIVE = ['new', 'backlog', 'reviewed'] as const;

export function Birthdays() {
  const { db, bump } = useStore();
  const [notice, setNotice] = useState<string | null>(null);
  const data = useQuery(async () => {
    const people = await listPeople(db, { status: [...ACTIVE] });
    return { people, scores: await loadScores(db, people) };
  });
  if (!data) return null;

  const today = new Date();
  const withBday = data.people.filter((p) => daysUntilBirthday(p.birthday, today) !== null);
  const soon = withBday
    .map((p) => ({ p, days: daysUntilBirthday(p.birthday, today)! }))
    .filter((x) => x.days <= 30)
    .sort((a, b) => a.days - b.days);
  const byMonth = MONTHS.map((_, i) =>
    withBday.filter((p) => birthMonth(p.birthday) === i + 1).sort((a, b) => birthDay(a.birthday)! - birthDay(b.birthday)!),
  );
  // Your closest people without a birthday yet: the ones most worth filling in.
  // Closeness score first, then hearts, then people you've filled in, then the most recently added.
  const score = (p: PersonListRow) => data.scores.get(p.id)?.score ?? 0;
  const missing = data.people
    .filter((p) => !p.birthday)
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        b.closeness - a.closeness ||
        Number(b.status === 'reviewed') - Number(a.status === 'reviewed') ||
        b.created_at.localeCompare(a.created_at),
    )
    .slice(0, 12);

  const downloadCalendar = () => {
    const blob = new Blob([birthdaysIcs(withBday)], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'birthdays.ics';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="page birthdays-page">
      <PageHead title="Birthdays" sub={`${withBday.length.toLocaleString()} ${withBday.length === 1 ? 'birthday' : 'birthdays'} saved`}>
        <button type="button" className="btn primary" disabled={!withBday.length} onClick={downloadCalendar}>
          📅 Add to my calendar
        </button>
      </PageHead>
      {notice && <p className="notice" role="status">✓ {notice}</p>}
      <p className="small muted">
        “Add to my calendar” downloads a calendar file with every birthday, repeating each year and reminding you the day before and that morning. Open it on your iPhone (or
        double-click it on your computer) and choose <strong>Add all</strong>. Download it again after adding new birthdays.
      </p>

      {soon.length > 0 && (
        <section>
          <h2 className="section-title">Next 30 days</h2>
          <ul className="list card">
            {soon.map(({ p, days }) => (
              <BirthdayRow key={p.id} p={p} sub={days === 0 ? '🎂 Today!' : `🎂 ${relativeDays(days)} · ${formatBirthday(p.birthday)}`} highlight={days === 0} />
            ))}
          </ul>
        </section>
      )}

      {missing.length > 0 && (
        <section>
          <h2 className="section-title">Add birthdays for your closest people</h2>
          <ul className="list card">
            {missing.map((p) => (
              <MissingRow
                key={p.id}
                p={p}
                onSave={async (b) => {
                  await updatePerson(db, p.id, { birthday: b });
                  setNotice(`Saved ${p.name}'s birthday.`);
                  bump();
                }}
              />
            ))}
          </ul>
        </section>
      )}

      {withBday.length === 0 ? (
        <Empty>
          No birthdays yet. Phone and Google contacts often include them, so import those on the <Link to="/sync">Import page</Link>, or add them above.
        </Empty>
      ) : (
        byMonth.map((list, i) =>
          list.length ? (
            <section key={i}>
              <h2 className="section-title">
                {MONTHS[i]} · {list.length}
              </h2>
              <ul className="list card">
                {list.map((p) => (
                  <BirthdayRow key={p.id} p={p} sub={formatBirthday(p.birthday)} />
                ))}
              </ul>
            </section>
          ) : null,
        )
      )}
    </div>
  );
}

function BirthdayRow({ p, sub, highlight }: { p: PersonListRow; sub: string; highlight?: boolean }) {
  const age = turningAge(p.birthday);
  return (
    <li className={`person-row${highlight ? ' birthday-today' : ''}`}>
      <Link to={`/person/${p.id}`} className="person-link">
        <Avatar name={p.name} photo={p.photo} size={36} />
        <span className="person-text">
          <span className="person-name">{p.name}</span>
          <span className="person-sub">
            {sub}
            {age !== null ? ` · turns ${age}` : ''}
            {p.city ? ` · 📍 ${p.city}` : ''}
          </span>
        </span>
      </Link>
    </li>
  );
}

function MissingRow({ p, onSave }: { p: PersonListRow; onSave: (birthday: string) => void }) {
  const [m, setM] = useState('');
  const [d, setD] = useState('');
  const days = m ? new Date(2000, Number(m), 0).getDate() : 31;
  return (
    <li className="person-row">
      <Link to={`/person/${p.id}`} className="person-link">
        <Avatar name={p.name} photo={p.photo} size={32} />
        <span className="person-text">
          <span className="person-name">{p.name}</span>
        </span>
      </Link>
      <div className="person-right row-gap">
        <select className="input" value={m} onChange={(e) => setM(e.target.value)} aria-label={`${p.name}'s birthday month`}>
          <option value="">Month</option>
          {MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <select className="input" value={d} onChange={(e) => setD(e.target.value)} aria-label={`${p.name}'s birthday day`}>
          <option value="">Day</option>
          {Array.from({ length: days }, (_, i) => (
            <option key={i} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
        <button type="button" className="btn secondary small" disabled={!m || !d} onClick={() => onSave(`${m.padStart(2, '0')}-${d.padStart(2, '0')}`)}>
          Save
        </button>
      </div>
    </li>
  );
}
