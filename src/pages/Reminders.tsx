import { Link } from 'react-router';
import { Empty, PageHead, PersonRow } from '@/components/ui';
import { listPeople, updatePerson, type Person } from '@/db/people';
import { daysBetween, daysUntilBirthday, followUpDue, isoDate, relativeDays } from '@/lib/dates';
import { useQuery, useStore } from '@/lib/store';
import { lastPhotoRound, photoQueue, PHOTO_ROUND_DAYS } from '@/db/photos';

export function Reminders() {
  const { db, bump } = useStore();
  const people = useQuery(() => listPeople(db, { status: ['new', 'backlog', 'reviewed'] }));
  // Monthly photo round: due when it's been a month (or never) and someone needs a picture.
  const photos = useQuery(async () => {
    const last = await lastPhotoRound(db);
    const due = !last || Date.now() - new Date(last).getTime() > PHOTO_ROUND_DAYS * 86400000;
    return { due, missing: due ? (await photoQueue(db)).length : 0 };
  });

  const today = new Date();
  const followUps: { p: Person; days: number }[] = [];
  const birthdays: { p: Person; days: number }[] = [];
  for (const p of people ?? []) {
    const due = followUpDue(p);
    if (due) {
      const days = daysBetween(today, due);
      if (days <= 7) followUps.push({ p, days });
    }
    const b = daysUntilBirthday(p.birthday, today);
    if (b !== null && b <= 30) birthdays.push({ p, days: b });
  }
  followUps.sort((a, b) => a.days - b.days);
  birthdays.sort((a, b) => a.days - b.days);

  const markContacted = async (p: Person) => {
    await updatePerson(db, p.id, { last_contacted: isoDate() });
    bump();
  };

  return (
    <div className="page">
      <PageHead title="Reminders" sub="Who to reach out to this week, and birthdays in the next 30 days.">
        <Link className="btn secondary" to="/birthdays">
          🎂 All birthdays
        </Link>
        <Link className="btn secondary" to="/photos">
          📸 Photo round
        </Link>
      </PageHead>
      {people && !followUps.length && !birthdays.length && (
        <Empty>
          Nothing due this week. On someone's profile, set how often you want to keep in touch and add their birthday, and
          they'll show up here.
        </Empty>
      )}
      {photos?.due && photos.missing > 0 && (
        <section className="card pad row-gap">
          <span className="grow">
            <strong>📸 Monthly photo round</strong>
            <span className="block small muted">{photos.missing.toLocaleString()} people with an Instagram or LinkedIn link have no picture yet.</span>
          </span>
          <Link className="btn primary" to="/photos">Start</Link>
        </section>
      )}
      {followUps.length > 0 && (
        <section>
          <h2 className="section-title">Follow up</h2>
          <ul className="list card">
            {followUps.map(({ p, days }) => (
              <PersonRow
                key={p.id}
                person={p}
                subtitle={
                  <span className={days < 0 ? 'text-danger' : undefined}>
                    {days < 0 ? `Overdue · was due ${relativeDays(days)}` : `Reach out ${relativeDays(days)}`}
                  </span>
                }
                right={
                  <button className="btn secondary small" onClick={() => markContacted(p)}>
                    ✓ Talked today
                  </button>
                }
              />
            ))}
          </ul>
        </section>
      )}
      {birthdays.length > 0 && (
        <section>
          <h2 className="section-title">Upcoming birthdays</h2>
          <ul className="list card">
            {birthdays.map(({ p, days }) => (
              <PersonRow
                key={p.id}
                person={p}
                subtitle={days === 0 ? '🎂 Birthday today!' : `🎂 Birthday ${relativeDays(days)}`}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
