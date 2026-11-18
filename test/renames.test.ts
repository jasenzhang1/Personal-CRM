import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/schema.ts';
import { listPeople } from '../src/db/people.ts';
import { listDuplicates } from '../src/db/merge.ts';
import { listFollowEvents } from '../src/db/followers.ts';
import { parseFollowList, syncFollowList } from '../src/sync/igFollows.ts';
import { ingest } from '../src/sync/ingest.ts';
import { parseInstagram, type Candidate } from '../src/sync/parsers.ts';
import { matchRenames } from '../src/sync/renames.ts';
import { profileUrl } from '../src/lib/sourceLinks.ts';

function fakeDb() {
  const d = new DatabaseSync(':memory:');
  const args = (p: unknown[]) => (p.length === 1 && Array.isArray(p[0]) ? p[0] : p) as any[];
  return {
    execAsync: async (sql: string) => void d.exec(sql),
    runAsync: async (sql: string, ...p: unknown[]) => {
      const r = d.prepare(sql).run(...args(p));
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    getFirstAsync: async (sql: string, ...p: unknown[]) => {
      const r = d.prepare(sql).get(...args(p));
      return r ? { ...r } : null;
    },
    getAllAsync: async (sql: string, ...p: unknown[]) => d.prepare(sql).all(...args(p)).map((r) => ({ ...r })),
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
  } as any;
}

const DAY = 86400;
const T = 1700000000; // 2023-11-14
/** A followers_1.json with each account's own follow time. */
const followers = (...us: [string, number][]) =>
  JSON.stringify(us.map(([u, ts]) => ({ string_list_data: [{ value: u, href: `https://www.instagram.com/${u}`, timestamp: ts }] })));

/** One Instagram import as the app does it: follow lists first, then people. */
async function importInstagram(db: any, json: string, date: string) {
  const r = await syncFollowList(db, 'followers', parseFollowList(json), date);
  await ingest(db, 'instagram', parseInstagram(JSON.parse(json)));
  return r;
}

test('matching renames needs the same connection date, and one of each is a sure match', () => {
  assert.deepEqual(matchRenames([{ id: 'old', on: '2024-01-01' }], [{ id: 'new', on: '2024-01-01' }]), [{ oldId: 'old', newId: 'new', unique: true }]);
  assert.deepEqual(matchRenames([{ id: 'old', on: '2024-01-01' }], [{ id: 'new', on: '2024-01-02' }]), []);
  assert.deepEqual(matchRenames([{ id: 'old', on: null }], [{ id: 'new', on: null }]), []);
  // Two of each: every pairing, but not sure. With needWord, only names that share a word.
  const gone = [{ id: 'a', on: 'd', name: 'Jane Smith' }, { id: 'b', on: 'd', name: 'Tom Lee' }];
  const arrived = [{ id: 'c', on: 'd', name: 'Jane Doe' }, { id: 'e', on: 'd', name: 'Sam Park' }];
  assert.equal(matchRenames(gone, arrived).length, 4);
  assert.deepEqual(matchRenames(gone, arrived, true), [{ oldId: 'a', newId: 'c', unique: false }]);
});

test('an Instagram username change moves the person over instead of adding someone new', async () => {
  const db = fakeDb();
  await migrate(db);
  await importInstagram(db, followers(['amy', T], ['bob.k', T + DAY]), '2026-10-01');
  const r = await importInstagram(db, followers(['amy', T], ['bobby.kim', T + DAY], ['newfan', 1793000000]), '2026-11-16');
  assert.deepEqual([r.renamed, r.gained, r.lost], [1, 1, 0]);

  const people = await listPeople(db);
  assert.deepEqual(people.map((p) => p.name).sort(), ['amy', 'bobby.kim', 'newfan']);
  const bob = people.find((p) => p.name === 'bobby.kim')!;
  assert.equal(bob.ig_handle, 'bobby.kim');
  // No "unfollowed you" for the old username, and the new one isn't a new follower.
  assert.deepEqual((await listFollowEvents(db)).map((e) => [e.kind, e.username]), [['followed_me', 'newfan']]);
});

test('a renamed Instagram account keeps the name you gave them', async () => {
  const db = fakeDb();
  await migrate(db);
  await importInstagram(db, followers(['bob.k', T]), '2026-10-01');
  const [bob] = await listPeople(db);
  await db.runAsync("UPDATE people SET name = 'Bob Kim', name_ok = 1 WHERE id = ?", bob.id);
  await importInstagram(db, followers(['bobby.kim', T]), '2026-11-16');
  const people = await listPeople(db);
  assert.deepEqual(people.map((p) => [p.name, p.ig_handle]), [['Bob Kim', 'bobby.kim']]);
});

test('several Instagram renames on the same date are only suggested on Duplicates', async () => {
  const db = fakeDb();
  await migrate(db);
  await importInstagram(db, followers(['sunflower', T], ['moonlight', T]), '2026-10-01');
  const r = await importInstagram(db, followers(['riverstone', T], ['cloudnine', T]), '2026-11-16');
  assert.equal(r.renamed, 0);
  assert.equal((await listPeople(db)).length, 4);
  const pairs = (await listDuplicates(db)).filter((p) => p.reason === 'renamed');
  assert.equal(pairs.length, 4);
  assert.ok(pairs.every((p) => !p.strong));
});

const discord = (id: string, name: string, username: string): Candidate => ({ source: 'discord', externalId: id, name, handle: `@${username}` });

test('a Discord username change updates the handle, and the name if it was the old username', async () => {
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'discord', [discord('111111', 'oldtag', 'oldtag'), discord('222222', 'Cat', 'catz')]);
  const r = await ingest(db, 'discord', [discord('111111', 'newtag', 'newtag'), discord('222222', 'Cat', 'catz2')]);
  assert.equal(r.relabeled, 2);
  assert.equal(r.added, 0);
  const rows = await db.getAllAsync("SELECT p.name, s.handle FROM sources s JOIN people p ON p.id = s.person_id WHERE s.source = 'discord' ORDER BY s.external_id");
  assert.deepEqual(rows.map((x: any) => [x.name, x.handle]), [['newtag', '@newtag'], ['Cat', '@catz2']]);
});

const linkedin = (url: string, name: string, on: string): Candidate => ({ source: 'linkedin', externalId: url, name, connectedOn: on });

test('a LinkedIn connection with a new profile link and name is suggested as a duplicate', async () => {
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'linkedin', [linkedin('https://www.linkedin.com/in/janesmith', 'Jane Smith', '2024-03-01'), linkedin('https://www.linkedin.com/in/tom', 'Tom Lee', '2024-03-02')]);
  const r = await ingest(db, 'linkedin', [linkedin('https://www.linkedin.com/in/janedoe', 'Jane Doe', '2024-03-01'), linkedin('https://www.linkedin.com/in/tom', 'Tom Lee', '2024-03-02')]);
  assert.equal(r.maybeRenamed, 1);
  const people = new Map((await listPeople(db)).map((p) => [p.id, p.name]));
  const pairs = (await listDuplicates(db)).filter((p) => p.reason === 'renamed');
  assert.deepEqual(pairs.map((p) => [people.get(p.a), people.get(p.b)].sort()), [['Jane Doe', 'Jane Smith']]);
});

test('a partial LinkedIn file does not count everyone missing as renamed', async () => {
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'linkedin', ['a', 'b', 'c', 'd'].map((x) => linkedin(`https://www.linkedin.com/in/${x}`, `Person ${x}`, '2024-01-01')));
  const r = await ingest(db, 'linkedin', [linkedin('https://www.linkedin.com/in/e', 'Person E', '2024-01-01')]);
  assert.equal(r.maybeRenamed, 0);
});

test('Facebook friends link to a search for their name', () => {
  assert.equal(profileUrl('facebook', 'jane doe', null), 'https://www.facebook.com/search/people/?q=jane%20doe');
  assert.equal(profileUrl('facebook', 'chat:facebook:123', null), null);
});
