import type { SQLiteDatabase } from '@/db/types';
import { getSetting, setSetting, type Person } from '@/db/people';
import type { Candidate, SourceKind } from './parsers';

export interface IngestResult {
  source: SourceKind;
  total: number;
  added: number;   // brand-new people
  linked: number;  // matched to someone already in the CRM
  /** True on the first sync of a source: everyone goes to the backlog, not the inbox. */
  baseline: boolean;
}

const digits = (s: string) => s.replace(/\D/g, '');
/** Compare phones on their last 10 digits so "+1 (310) 555-0100" matches "3105550100". */
const phoneKey = (s: string) => {
  const d = digits(s);
  return d.length >= 7 ? d.slice(-10) : null;
};
const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Merge candidates from one source into the CRM.
 *
 * - Already-known (source, externalId) pairs are skipped, but missing details get filled in.
 * - Otherwise we try to match an existing person by email, phone, or (unique) exact name,
 *   so the same friend from your phone and LinkedIn becomes one record.
 * - Anyone left is created. On the very first sync of a source they land in the "backlog"
 *   (people you already knew); after that, new arrivals land in the Inbox to be filled in.
 */
export async function ingest(db: SQLiteDatabase, source: SourceKind, candidates: Candidate[]): Promise<IngestResult> {
  const baselineKey = `baseline_${source}`;
  const baseline = (await getSetting(db, baselineKey)) === null;
  const result: IngestResult = { source, total: candidates.length, added: 0, linked: 0, baseline };

  const people = await db.getAllAsync<Person>('SELECT * FROM people');
  const known = new Map(
    (await db.getAllAsync<{ external_id: string; person_id: number }>(
      'SELECT external_id, person_id FROM sources WHERE source = ?', source,
    )).map((r) => [r.external_id, r.person_id]),
  );

  const linkedHere = new Set(known.values()); // person ids that already have an entry from this source
  const byEmail = new Map<string, Person>();
  const byPhone = new Map<string, Person>();
  const byName = new Map<string, Person[]>();
  const byId = new Map<number, Person>();
  const index = (p: Person) => {
    byId.set(p.id, p);
    if (p.email) byEmail.set(p.email.toLowerCase(), p);
    const pk = p.phone && phoneKey(p.phone);
    if (pk) byPhone.set(pk, p);
    const nk = nameKey(p.name);
    byName.set(nk, [...(byName.get(nk) ?? []), p]);
  };
  people.forEach(index);

  const t = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    for (const c of candidates) {
      const email = c.emails?.find(Boolean) ?? null;
      const phone = c.phones?.find(Boolean) ?? null;

      const knownId = known.get(c.externalId);
      let person = knownId !== undefined ? byId.get(knownId) : undefined;
      const isKnown = !!person;

      if (!person) {
        // A name match must be unambiguous, and must not already be a *different* entry from this
        // same source (two "Sam Lee"s in your phone are two people).

        const sameName = (byName.get(nameKey(c.name)) ?? []).filter((p) => !linkedHere.has(p.id));
        person =
          (email && byEmail.get(email.toLowerCase())) ||
          (phone && phoneKey(phone) ? byPhone.get(phoneKey(phone)!) : undefined) ||
          (sameName.length === 1 && (byName.get(nameKey(c.name))?.length ?? 0) === 1 ? sameName[0] : undefined);
      }

      if (person) {
        // Fill only blanks — never overwrite what the user typed.
        const fill: Record<string, string> = {};
        if (!person.email && email) fill.email = email;
        if (!person.phone && phone) fill.phone = phone;
        if (!person.birthday && c.birthday) fill.birthday = c.birthday;
        if (!person.photo && c.photo) fill.photo = c.photo;
        if (!person.company && c.company) fill.company = c.company;
        if (!person.title && c.title) fill.title = c.title;
        if (!person.city && c.city) fill.city = c.city;
        if (!person.met_on && c.connectedOn) fill.met_on = c.connectedOn;
        const keys = Object.keys(fill);
        if (keys.length) {
          await db.runAsync(
            `UPDATE people SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
            [...keys.map((k) => fill[k]), t, person.id],
          );
          Object.assign(person, fill);
        }
        if (!isKnown) {
          await db.runAsync(
            'INSERT OR IGNORE INTO sources (person_id, source, external_id, handle, first_seen, connected_on) VALUES (?, ?, ?, ?, ?, ?)',
            person.id, source, c.externalId, c.handle ?? null, t, c.connectedOn ?? null,
          );
          known.set(c.externalId, person.id);
          linkedHere.add(person.id);
          result.linked++;
        }
        continue;
      }

      const r = await db.runAsync(
        `INSERT INTO people (name, phone, email, birthday, photo, company, title, city, met_on, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.name, phone, email, c.birthday ?? null, c.photo ?? null, c.company ?? null, c.title ?? null, c.city ?? null,
        c.connectedOn ?? null, baseline || c.quiet ? 'backlog' : 'new', t, t,
      );
      const id = r.lastInsertRowId;
      await db.runAsync(
        'INSERT OR IGNORE INTO sources (person_id, source, external_id, handle, first_seen, connected_on) VALUES (?, ?, ?, ?, ?, ?)',
        id, source, c.externalId, c.handle ?? null, t, c.connectedOn ?? null,
      );
      known.set(c.externalId, id);
      linkedHere.add(id);
      const created = (await db.getFirstAsync<Person>('SELECT * FROM people WHERE id = ?', id))!;
      index(created);
      result.added++;
    }
    // Fill in connection dates for accounts imported before dates were kept (re-imports).
    const dated = candidates.filter((c) => c.connectedOn);
    for (const c of dated)
      await db.runAsync('UPDATE sources SET connected_on = ? WHERE source = ? AND external_id = ? AND connected_on IS NULL', c.connectedOn!, source, c.externalId);
    if (baseline) await setSetting(db, baselineKey, t);
    await setSetting(db, `last_sync_${source}`, t);
  });

  return result;
}
