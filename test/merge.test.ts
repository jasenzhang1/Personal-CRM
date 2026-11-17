import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/schema.ts';
import { ingest } from '../src/sync/ingest.ts';
import { parseInstagram } from '../src/sync/parsers.ts';
import { importChats } from '../src/sync/activity.ts';
import { createPerson, getTags, setTags } from '../src/db/people.ts';
import { dismissDuplicate, listDuplicates, mergePeople } from '../src/db/merge.ts';
import { listRanking, logInteraction, setPlacement } from '../src/db/ranking.ts';
import { findDuplicates } from '../src/lib/duplicates.ts';

function fakeDb() {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
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

const P = (id: number, name: string, ig?: string, extra: object = {}) => ({
  id, name, email: null, phone: null,
  sources: ig ? [{ source: 'instagram', external_id: ig, handle: '@' + ig, display_name: null }] : [],
  ...extra,
});

test('finding duplicates: usernames, same names, initials, but not two different accounts', () => {
  const pairs = findDuplicates([
    P(1, 'jackiezhang26', 'jackiezhang26'),
    P(2, 'Jackie Zhang'),
    P(3, 'lydiiiaaa.lu', 'lydiiiaaa.lu'),
    P(4, 'Lydia Lu'),
    P(5, 'jsmith', 'jsmith'),
    P(6, 'John Smith'),
    P(7, 'Kevin Lee', 'kevinlee1'),
    P(8, 'Kevin Lee', 'kevin.lee.2'), // same name, different Instagram accounts → weak
    P(9, 'Amy Tran'),
    P(10, 'amy tran'),
    P(11, 'Sam', undefined, { email: 'sam@x.com' }),
    P(12, 'Samuel Ortiz', undefined, { email: 'SAM@x.com' }),
  ]);
  const got = Object.fromEntries(pairs.map((p) => [`${p.a}-${p.b}`, `${p.reason}${p.strong ? '' : '?'}`]));
  assert.deepEqual(got, {
    '11-12': 'same-contact',
    '1-2': 'username',
    '9-10': 'same-name',
    '7-8': 'same-name?',
    '3-4': 'suggested?',
    '5-6': 'initial?',
  });
  assert.equal(findDuplicates([P(1, 'Jackie Zhang'), P(2, 'Jackie Zhang')], new Set(['1:2'])).length, 0);
});

test('merging keeps everything and future imports land on the kept person', async () => {
  const db = fakeDb();
  await migrate(db);
  const follower = (u: string) => ({ string_list_data: [{ value: u, href: `https://www.instagram.com/${u}`, timestamp: 1700000000 }] });
  await ingest(db, 'instagram', parseInstagram([follower('jackiezhang26')]));
  const chat = { source: 'instagram', threadId: 'jz_999', otherName: 'Jackie Zhang', messages: 30, calls: 1, callSeconds: 600, days: [{ day: '2026-11-10', messages: 30, calls: 1, call_seconds: 600 }] } as any;
  await importChats(db, [chat]);
  const all = await db.getAllAsync('SELECT id, name FROM people ORDER BY id');
  const [ig, chatPerson] = all.map((r: any) => r.id);
  await db.runAsync("UPDATE people SET notes = 'Met at UCLA', birthday = '03-14' WHERE id = ?", chatPerson);
  await db.runAsync("UPDATE people SET notes = 'Loves boba', status = 'reviewed' WHERE id = ?", ig);
  await setTags(db, ig, ['UCLA']);
  await setTags(db, chatPerson, ['ucla', 'Climbing']);
  await setPlacement(db, chatPerson, 8.5, 3);
  await logInteraction(db, ig, '2026-11-10', 30);

  const pairs = await listDuplicates(db);
  assert.deepEqual(pairs.map((p) => [p.a, p.b, p.reason]), [[ig, chatPerson, 'username']]);

  await mergePeople(db, chatPerson, ig);
  const [p] = await db.getAllAsync('SELECT * FROM people');
  assert.equal((await db.getAllAsync('SELECT * FROM people')).length, 1);
  assert.equal(p.name, 'Jackie Zhang');
  assert.equal(p.notes, 'Met at UCLA\n\nLoves boba');
  assert.equal(p.birthday, '03-14');
  assert.equal(p.status, 'reviewed');
  assert.deepEqual((await getTags(db, chatPerson)).map((t) => t.toLowerCase()).sort(), ['climbing', 'ucla']);
  assert.equal((await listRanking(db))[0].base, 8.5);
  const act = await db.getFirstAsync('SELECT SUM(messages) m, SUM(calls) c FROM interactions WHERE person_id = ?', chatPerson);
  assert.deepEqual([act.m, act.c], [30, 2]);
  assert.equal((await listDuplicates(db)).length, 0);

  // Re-importing both exports doesn't bring the duplicate back or double-count.
  await ingest(db, 'instagram', parseInstagram([follower('jackiezhang26')]));
  await importChats(db, [chat]);
  assert.equal((await db.getAllAsync('SELECT * FROM people')).length, 1);
  const again = await db.getFirstAsync("SELECT SUM(messages) m FROM interactions WHERE person_id = ? AND source = 'instagram'", chatPerson);
  assert.equal(again.m, 30);
});

test('merging with a new name, and "not the same person" sticks', async () => {
  const db = fakeDb();
  await migrate(db);
  const a = await createPerson(db, { name: 'Amy Tran' });
  const b = await createPerson(db, { name: 'amy tran' });
  const c = await createPerson(db, { name: 'Amy Tran' });
  assert.equal((await listDuplicates(db)).length, 3);
  await dismissDuplicate(db, c, a);
  await dismissDuplicate(db, c, b);
  assert.equal((await listDuplicates(db)).length, 1);
  await mergePeople(db, b, a, 'Amy N. Tran');
  const kept = await db.getFirstAsync('SELECT name, name_ok FROM people WHERE id = ?', b);
  assert.deepEqual([kept.name, kept.name_ok], ['Amy N. Tran', 1]);
  assert.equal((await listDuplicates(db)).length, 0);
});

test('username matching avoids look-alike names', () => {
  const pairs = (u: string, name: string) => findDuplicates([P(1, u, u), P(2, name)]).map((p) => `${p.reason}${p.strong ? '' : '?'}`);
  assert.deepEqual(pairs('notarthurzhou', 'Arthur Zhou'), ['username']);
  assert.deepEqual(pairs('darren.linsta', 'Darren Lin'), ['username']);
  assert.deepEqual(pairs('nataliewucomedy', 'Natalie Wu'), ['username']);
  assert.deepEqual(pairs('kellylin', 'Kelly Li'), []);
  assert.deepEqual(pairs('senyoungkim', 'Young Kim'), []);
  const chat = findDuplicates([{ ...P(1, '_stephen007_', '_stephen007_'), sources: [{ source: 'instagram', external_id: 'chat:s_1', handle: null, display_name: 'Stephen' }] }, P(2, 'Stephen')]);
  assert.deepEqual(chat.map((p) => p.strong), [false]);
});
