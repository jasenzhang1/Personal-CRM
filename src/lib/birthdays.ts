/**
 * Birthday helpers: ages, and a calendar file (.ics) so your phone's calendar reminds you.
 * A website can't send notifications by itself, but your calendar can.
 */
import { daysUntilBirthday, isValidBirthday } from './dates';

const md = (b: string) => (b.length === 10 ? b.slice(5) : b);

/** Age they turn on their next birthday, if you know the year. */
export function turningAge(birthday: string | null, today = new Date()): number | null {
  if (!birthday || birthday.length !== 10 || !isValidBirthday(birthday)) return null;
  const year = Number(birthday.slice(0, 4));
  const days = daysUntilBirthday(birthday, today);
  if (days === null) return null;
  const next = new Date(today);
  next.setDate(next.getDate() + days);
  return next.getFullYear() - year;
}

/** 1–12, or null. */
export const birthMonth = (b: string | null) => (b && isValidBirthday(b) ? Number(md(b).slice(0, 2)) : null);
export const birthDay = (b: string | null) => (b && isValidBirthday(b) ? Number(md(b).slice(3, 5)) : null);

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
/** Lines longer than 75 bytes must be folded in .ics files. */
const fold = (line: string) => {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    out.push(rest.slice(0, 73));
    rest = ' ' + rest.slice(73);
  }
  out.push(rest);
  return out.join('\r\n');
};

/**
 * One yearly, all-day event per birthday with a reminder at 9am that morning (and the day before).
 * Open the file on your iPhone or computer and "Add all" to your calendar.
 */
export function birthdaysIcs(people: { id: number; name: string; birthday: string | null }[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Personal CRM//Birthdays//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Birthdays (Personal CRM)'];
  for (const p of people) {
    if (!p.birthday || !isValidBirthday(p.birthday)) continue;
    const [m, d] = md(p.birthday).split('-');
    // Start in the birth year when known (calendars then show "turning N"), else a leap year so Feb 29 works.
    const year = p.birthday.length === 10 ? p.birthday.slice(0, 4) : '2000';
    const start = `${year}${m}${d}`;
    const endDate = new Date(Number(year), Number(m) - 1, Number(d) + 1);
    const end = `${endDate.getFullYear()}${String(endDate.getMonth() + 1).padStart(2, '0')}${String(endDate.getDate()).padStart(2, '0')}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:birthday-${p.id}@personal-crm`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      m === '02' && d === '29' ? 'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1' : 'RRULE:FREQ=YEARLY',
      fold(`SUMMARY:${icsText(`🎂 ${p.name}'s birthday`)}`),
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${icsText(`${p.name}'s birthday today`)}`), 'TRIGGER:PT9H', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${icsText(`${p.name}'s birthday is tomorrow`)}`), 'TRIGGER:-PT15H', 'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
