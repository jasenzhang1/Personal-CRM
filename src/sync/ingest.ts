import type { SQLiteDatabase } from '@/db/types';
import { getSetting, setSetting, type Person } from '@/db/people';
import type { Candidate, SourceKind } from './parsers';
import { matchRenames, suggestRename, type Account } from './renames';

export interface IngestResult {
  source: SourceKind;
  total: number;
  added: number;   // brand-new people
  linked: number;  // matched to someone already in the CRM
  /** True on the first sync of a source: everyone goes to the backlog, not the inbox. */
  baseline: boolean;
  /** Accounts whose username changed since last time (their handle, and name if it was the old username, were updated). */
  relabeled: number;
  /** Possible renames (an account vanished and one with the same connection date appeared), listed on Duplicates. */
  maybeRenamed: number;
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
  const result: IngestResult = { source, total: candidates.length, added: 0, linked: 0, baseline, relabeled: 0, maybeRenamed: 0 };

  const people = await db.getAllAsync<Person>('SELECT * FROM people');
  const knownRows = await db.getAllAsync<{ external_id: string; person_id: number; handle: string | null; connected_on: string | null }>(
    'SELECT external_id, person_id, handle, connected_on FROM sources WHERE source = ?', source,
  );
  const known = new Map(knownRows.map((r) => [r.external_id, r.person_id]));
  const handles = new Map(knownRows.map((r) => [r.external_id, r.handle]));
  /** Accounts first seen in this import, for spotting renames. */
  const fresh: Account[] = [];

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
      if (!isKnown) fresh.push({ id: c.externalId, on: c.connectedOn ?? null, name: c.name });

      // Same account, new username (Discord keeps the account id): update the handle, and their
      // name too if it was still just the old username and you never confirmed it.
      const oldHandle = handles.get(c.externalId);
      if (person && c.handle && oldHandle !== undefined && oldHandle !== c.handle) {
        await db.runAsync('UPDATE sources SET handle = ? WHERE source = ? AND external_id = ?', c.handle, source, c.externalId);
        if (oldHandle && oldHandle.toLowerCase() !== c.handle.toLowerCase()) {
          result.relabeled++;
          const bare = oldHandle.replace(/^@/, '').toLowerCase();
          const r = await db.runAsync(
            'UPDATE people SET name = ?, updated_at = ? WHERE id = ? AND name_ok = 0 AND lower(name) IN (?, ?)',
            c.name, t, person.id, bare, `@${bare}`,
          );
          if (r.changes) person.name = c.name;
        }
      }

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
    // Needs connection dates: the Facebook friend-links file has none, so it skips this.
    if ((source === 'linkedin' || source === 'facebook') && dated.length) result.maybeRenamed = await spotRenames(db, source, candidates, knownRows, fresh, t);
    if (baseline) await setSetting(db, baselineKey, t);
    await setSetting(db, `last_sync_${source}`, t);
  });

  return result;
}

/**
 * LinkedIn connections are known by profile URL and Facebook friends by name, so a new custom URL
 * or a name change makes a second person. When a connection vanished from this export and a new
 * one appeared with the same "connected on" date, suggest them as duplicates (it's never automatic:
 * a name change and a new friend on the same day both happen).
 */
async function spotRenames(
  db: SQLiteDatabase,
  source: SourceKind,
  candidates: Candidate[],
  knownRows: { external_id: string; person_id: number; connected_on: string | null }[],
  fresh: Account[],
  t: string,
): Promise<number> {
  const accounts = knownRows.filter((r) => !r.external_id.startsWith('chat:'));
  // Only a full list says who's gone: skip a partial file.
  if (!accounts.length || candidates.length < accounts.length / 2) return 0;
  const present = new Set(candidates.map((c) => c.externalId));
  const names = new Map((await db.getAllAsync<{ id: number; name: string }>('SELECT id, name FROM people')).map((p) => [p.id, p.name]));
  const gone = accounts.filter((r) => !present.has(r.external_id)).map((r) => ({ id: r.external_id, on: r.connected_on, name: names.get(r.person_id) }));
  let n = 0;
  for (const m of matchRenames(gone, fresh, true)) {
    await suggestRename(db, source, m.oldId, m.newId, t.slice(0, 10));
    n++;
  }
  return n;
}
