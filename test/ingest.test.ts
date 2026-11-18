import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/schema.ts';
import { allTags, getStageEvents, getTags, listPeople, setStage, setTags, updatePerson } from '../src/db/people.ts';
import { ingest } from '../src/sync/ingest.ts';
import type { Candidate } from '../src/sync/parsers.ts';

/** Minimal stand-in for expo-sqlite's async API, backed by Node's built-in SQLite. */
function fakeDb() {
  const d = new DatabaseSync(':memory:');
  const args = (p: unknown[]) => (p.length === 1 && Array.isArray(p[0]) ? p[0] : p) as any[];
  const db = {
    execAsync: async (sql: string) => void d.exec(sql),
    runAsync: async (sql: string, ...p: unknown[]) => {
      const r = d.prepare(sql).run(...args(p));
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    getFirstAsync: async (sql: string, ...p: unknown[]) => d.prepare(sql).get(...args(p)) ?? null,
    getAllAsync: async (sql: string, ...p: unknown[]) => d.prepare(sql).all(...args(p)),
    withTransactionAsync: async (fn: () => Promise<void>) => {
      d.exec('BEGIN');
      try {
        await fn();
        d.exec('COMMIT');
      } catch (e) {
        d.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return db as any;
}

const phone = (id: string, name: string, extra: Partial<Candidate> = {}): Candidate => ({ source: 'phone', externalId: id, name, ...extra });

test('first sync goes to backlog, later new contacts go to the inbox', async () => {
  const db = fakeDb();
  await migrate(db);
  const r1 = await ingest(db, 'phone', [phone('1', 'Ada Lovelace'), phone('2', 'Alan Turing')]);
  assert.deepEqual([r1.baseline, r1.added], [true, 2]);
  assert.equal((await listPeople(db, { status: ['backlog'] })).length, 2);

  const r2 = await ingest(db, 'phone', [phone('1', 'Ada Lovelace'), phone('2', 'Alan Turing'), phone('3', 'Grace Hopper')]);
  assert.deepEqual([r2.baseline, r2.added, r2.linked], [false, 1, 0]);
  const inbox = await listPeople(db, { status: ['new'] });
  assert.deepEqual(inbox.map((p) => p.name), ['Grace Hopper']);
});

test('the same person across sources is merged by phone, email or unique name', async () => {
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'phone', [
    phone('1', 'Ada L', { phones: ['+1 (310) 555-0100'], emails: ['ada@example.com'] }),
    phone('2', 'Alan Turing'),
    phone('3', 'Sam Lee'),
    phone('4', 'Sam Lee'),
  ]);
  const r = await ingest(db, 'linkedin', [
    { source: 'linkedin', externalId: 'in/ada', name: 'Ada Lovelace', emails: ['ADA@example.com'], company: 'Engines', connectedOn: '2020-01-01' },
    { source: 'linkedin', externalId: 'in/alan', name: 'alan  turing' },
    { source: 'linkedin', externalId: 'in/sam', name: 'Sam Lee' }, // ambiguous name → new record
  ]);
  assert.deepEqual([r.linked, r.added], [2, 1]);
  const all = await listPeople(db);
  assert.equal(all.length, 5);
  const ada = all.find((p) => p.name === 'Ada L')!;
  assert.equal(ada.company, 'Engines'); // blanks filled in
  assert.equal(ada.met_on, '2020-01-01');
});

test('re-import never overwrites what the user typed', async () => {
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'linkedin', [{ source: 'linkedin', externalId: 'in/x', name: 'X', company: 'Old Co' }]);
  const [x] = await listPeople(db);
  await updatePerson(db, x.id, { company: 'My Label', how_met: 'Conference', status: 'reviewed' });
  await ingest(db, 'linkedin', [{ source: 'linkedin', externalId: 'in/x', name: 'X', company: 'New Co' }]);
  const [after] = await listPeople(db);
  assert.deepEqual([after.company, after.how_met, after.status], ['My Label', 'Conference', 'reviewed']);
});

test('stage changes are logged to the lifecycle timeline', async () => {
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'phone', [phone('1', 'Client')]);
  const [c] = await listPeople(db);
  await setStage(db, c.id, 'lead');
  await setStage(db, c.id, 'meeting');
  await setStage(db, c.id, 'meeting'); // no-op
  const events = await getStageEvents(db, c.id);
  assert.deepEqual(
    events.map((e) => [e.from_stage, e.to_stage]).reverse(),
    [[null, 'lead'], ['lead', 'meeting']],
  );
});

test('tags: case-insensitive, searchable, filterable; list rows carry sources and tags', async () => {
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'phone', [phone('1', 'Ada Lovelace'), phone('2', 'Alan Turing')]);
  await ingest(db, 'linkedin', [{ source: 'linkedin', externalId: 'u/ada', name: 'Ada Lovelace' }]);
  const [ada, alan] = await listPeople(db);
  await setTags(db, ada.id, ['UCLA', 'ucla', 'Pickleball']);
  await setTags(db, alan.id, ['UCLA']);
  assert.deepEqual(await getTags(db, ada.id), ['Pickleball', 'UCLA']);
  assert.deepEqual((await allTags(db)).map((t) => ({ ...t })), [{ tag: 'UCLA', n: 2 }, { tag: 'Pickleball', n: 1 }]);
  assert.deepEqual((await listPeople(db, { tag: 'ucla' })).map((p) => p.name), ['Ada Lovelace', 'Alan Turing']);
  assert.deepEqual((await listPeople(db, { search: 'pickle' })).map((p) => p.name), ['Ada Lovelace']);
  const row = (await listPeople(db))[0];
  assert.deepEqual([...row.sources].sort(), ['linkedin', 'phone']);
  assert.deepEqual(row.tags, ['Pickleball', 'UCLA']);
  await updatePerson(db, ada.id, { circle: 'both' });
  assert.equal((await listPeople(db))[0].circle, 'both');
});

test('migrating a version-1 database adds the new column and tags table', async () => {
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'phone', [phone('1', 'Ada Lovelace')]);
  // Turn it back into a version-1 database, as it was before this update.
  await db.execAsync('DROP TABLE person_tags; ALTER TABLE people DROP COLUMN circle; PRAGMA user_version = 1;');
  await migrate(db);
  assert.equal((await db.getFirstAsync('PRAGMA user_version')).user_version, 13);
  const [ada] = await listPeople(db);
  assert.equal(ada.circle, null);
  await setTags(db, ada.id, ['UCLA']);
  assert.deepEqual(await getTags(db, ada.id), ['UCLA']);
});
