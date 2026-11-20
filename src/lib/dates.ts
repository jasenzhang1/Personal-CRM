import { FOLLOW_UPS, type FollowUp } from './constants';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date as YYYY-MM-DD. */
export function isoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseIsoDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isValidIsoDate(s: string): boolean {
  const d = parseIsoDate(s);
  return !!d && isoDate(d) === s.slice(0, 10);
}

/** Accepts 'MM-DD' or 'YYYY-MM-DD'. */
export function isValidBirthday(s: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isValidIsoDate(s);
  const m = /^(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  return isValidIsoDate(`2000-${m[1]}-${m[2]}`); // leap year so 02-29 is allowed
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

export function daysBetween(a: Date, b: Date): number {
  const ms = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() -
    new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  return Math.round(ms / 86_400_000);
}

/** When the next follow-up is due, or null if no cadence is set. */
export function followUpDue(p: {
  follow_up: string;
  last_contacted: string | null;
  met_on: string | null;
  created_at: string;
}): Date | null {
  const cadence = FOLLOW_UPS.find((f) => f.key === (p.follow_up as FollowUp));
  if (!cadence || cadence.days === 0) return null;
  const base = parseIsoDate(p.last_contacted) ?? parseIsoDate(p.met_on) ?? parseIsoDate(p.created_at) ?? new Date();
  return addDays(base, cadence.days);
}

/** Days until the next birthday (0 = today), or null if unknown. */
export function daysUntilBirthday(birthday: string | null, today = new Date()): number | null {
  if (!birthday || !isValidBirthday(birthday)) return null;
  const md = birthday.length === 10 ? birthday.slice(5) : birthday;
  const [m, d] = md.split('-').map(Number);
  let next = new Date(today.getFullYear(), m - 1, d);
  if (daysBetween(today, next) < 0) next = new Date(today.getFullYear() + 1, m - 1, d);
  return daysBetween(today, next);
}

export function formatDate(s: string | null | undefined): string {
  const d = parseIsoDate(s);
  if (!d) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatBirthday(s: string | null | undefined): string {
  if (!s) return '—';
  const md = s.length === 10 ? s.slice(5) : s;
  const [m, d] = md.split('-').map(Number);
  const label = new Date(2000, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return s.length === 10 ? `${label}, ${s.slice(0, 4)}` : label;
}

export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" for an ISO time. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (!(min >= 1)) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}
