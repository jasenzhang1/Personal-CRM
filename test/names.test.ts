import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { looksStandard, suggestName, tidyName } from '../src/lib/names.ts';
import { migrate } from '../src/db/schema.ts';
import { ingest } from '../src/sync/ingest.ts';
import { parseInstagram } from '../src/sync/parsers.ts';
import { applyNameSuggestions, keepName, nameReviewList, renamePerson } from '../src/db/names.ts';
import { importChats } from '../src/sync/activity.ts';

test('what counts as a proper First Last name', () => {
  for (const ok of ['John Smith', "Conan O'Brien", 'Mary-Jane Watson', 'Ana de la Cruz', 'DJ Khaled', 'AJ Lee', '张伟', 'José Álvarez'])
    assert.ok(looksStandard(ok), ok);
  for (const bad of ['john smith', 'JOHN SMITH', 'john.smith_99', 'johnsmith', 'John', 'John Smith 🌸', 'sk8r boi', '@jsmith'])
    assert.ok(!looksStandard(bad), bad);
});

test('tidying names keeps deliberate capitals', () => {
  assert.equal(tidyName('JOHN SMITH'), 'John Smith');
  assert.equal(tidyName('john mcdonald'), 'John McDonald');
  assert.equal(tidyName("conan o'brien"), "Conan O'Brien");
  assert.equal(tidyName('Jess Lee 🌸✨'), 'Jess Lee');
  assert.equal(tidyName('DeShawn jones'), 'DeShawn Jones');
  assert.equal(tidyName('ana de la cruz'), 'Ana de la Cruz');
});

test('suggestions from usernames, chats and capitals', () => {
  const s = (name: string, extra: object = {}) => suggestName({ name, ...extra });
  assert.deepEqual(s('john.smith_99'), { name: 'John Smith', confidence: 'high', reason: 'username' });
  assert.equal(s('sunset_vibes')?.confidence, 'medium');
  assert.deepEqual(s('johnsmith'), { name: 'John Smith', confidence: 'high', reason: 'split' });
  assert.deepEqual(s('zongyundeng'), { name: 'Zongyun Deng', confidence: 'medium', reason: 'split' });
  assert.deepEqual(s('dennyyoo_'), { name: 'Denny Yoo', confidence: 'high', reason: 'split' });
  assert.deepEqual(s('skylarrrzhang'), { name: 'Skylar Zhang', confidence: 'high', reason: 'split' });
  assert.deepEqual(s('jeremyjszeto'), { name: 'Jeremy Szeto', confidence: 'medium', reason: 'split' });
  assert.equal(s('Matthew'), null);
  assert.equal(s('ryan.kd9')?.confidence, 'medium');
  assert.deepEqual(s('edwin.m.yang'), { name: 'Edwin Yang', confidence: 'high', reason: 'username' });
  assert.deepEqual(s('nathanv09'), { name: 'Nathan', confidence: 'low', reason: 'first-only' });
  assert.equal(s('x', { chatNames: ['🌤☁️☁️'] }), null);
  assert.deepEqual(s('drjk', { chatNames: ['Dr Julian Kam'] }), { name: 'Julian Kam', confidence: 'high', reason: 'chat' });
  assert.deepEqual(s('itsjessicalee'), { name: 'Jessica Lee', confidence: 'high', reason: 'split' });
  assert.deepEqual(s('emma'), { name: 'Emma', confidence: 'low', reason: 'first-only' });
  assert.equal(s('xx_sk8r_xx'), null);
  assert.deepEqual(s('jsmith42', { chatNames: ['John Smith'] }), { name: 'John Smith', confidence: 'high', reason: 'chat' });
  assert.deepEqual(s('JOHN SMITH'), { name: 'John Smith', confidence: 'high', reason: 'tidy' });
  assert.equal(s('John Smith'), null);
  // A messy name with a useful username behind it
  assert.deepEqual(s('🌙', { usernames: ['@maria.garcia'] }), { name: 'Maria Garcia', confidence: 'high', reason: 'username' });
});

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

test('Instagram import → sure fixes applied, guesses left for review, your choices respected', async () => {
  const db = fakeDb();
  await migrate(db);
  const follower = (u: string) => ({ string_list_data: [{ value: u, href: `https://www.instagram.com/${u}`, timestamp: 1700000000 }] });
  await ingest(db, 'instagram', parseInstagram([follower('john.smith_99'), follower('jsmith42'), follower('chrls.dai'), follower('xx_sk8r_xx'), follower('keep.me.weird')]));
  // A chat whose folder matches @jsmith42 shows their real name.
  await importChats(db, [{ source: 'instagram', threadId: 'jsmith42_123', otherName: 'Jake Smithers', messages: 5, calls: 0, callSeconds: 0, days: [] } as any]);

  let list = await nameReviewList(db);
  assert.equal(list.length, 5);
  await keepName(db, list.find((r) => r.name === 'keep.me.weird')!.id);
  const { fixed, left } = await applyNameSuggestions(db);
  assert.equal(fixed, 2); // john.smith_99 → John Smith, jsmith42 → Jake Smithers
  assert.equal(left, 2); // chrls.dai (a guess) + xx_sk8r_xx (no idea)
  list = await nameReviewList(db);
  const names = (await db.getAllAsync('SELECT name FROM people ORDER BY name')).map((r: any) => r.name);
  assert.deepEqual(names, ['Jake Smithers', 'John Smith', 'chrls.dai', 'keep.me.weird', 'xx_sk8r_xx']);
  assert.equal(list.find((r) => r.name === 'chrls.dai')!.suggestion?.name, 'Chrls Dai');
  await renamePerson(db, list.find((r) => r.name === 'xx_sk8r_xx')!.id, 'Sky Ramirez');
  assert.equal((await nameReviewList(db)).length, 1);
  await applyNameSuggestions(db, { all: true });
  assert.equal((await nameReviewList(db)).length, 0);
});
