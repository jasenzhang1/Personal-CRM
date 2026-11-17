import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/schema.ts';
import { createPerson } from '../src/db/people.ts';
import { activitySummary, listRanking, loadScores, logInteraction, placePerson, swapRanking } from '../src/db/ranking.ts';
import { activityScore, answerPlacement, combineScore, nextOpponent, rankScores, startPlacement, type Placement } from '../src/lib/ranking.ts';
import { parseChats } from '../src/sync/messages.ts';
import { importChats } from '../src/sync/activity.ts';

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

/** Simulate answering truthfully against a hidden "true" order. */
function place(truth: number[], personId: number, tierOrder: number[]) {
  let p: Placement = startPlacement(personId, 'inner', tierOrder);
  let asked = 0;
  for (let o = nextOpponent(p); o !== null; o = nextOpponent(p)) {
    asked++;
    p = answerPlacement(p, truth.indexOf(personId) < truth.indexOf(o) ? 'new' : 'other');
  }
  return { index: p.lo, asked };
}

test('binary-search placement finds the right spot in few questions', () => {
  const truth = Array.from({ length: 64 }, (_, i) => i + 1); // 1 is closest
  const existing = truth.filter((x) => x !== 40);
  const { index, asked } = place(truth, 40, existing);
  assert.equal(index, 39);
  assert.ok(asked <= 6, `asked ${asked}`);
  assert.equal(place(truth, 1, existing.filter((x) => x !== 1)).index, 0);
});

test('tie places right below the person compared', () => {
  const p = startPlacement(9, 'close', [1, 2, 3]);
  assert.equal(nextOpponent(p), 2);
  const done = answerPlacement(p, 'tie');
  assert.equal(nextOpponent(done), null);
  assert.equal(done.lo, 2);
});

test('rank scores spread over each tier, best = top of range', () => {
  const s = rankScores([
    { person_id: 1, tier: 'inner', pos: 0, ranked_at: '' },
    { person_id: 2, tier: 'inner', pos: 1, ranked_at: '' },
    { person_id: 3, tier: 'casual', pos: 0, ranked_at: '' },
  ]);
  assert.deepEqual([s.get(1)!.feel, s.get(2)!.feel, s.get(3)!.feel], [10, 6.8, 3.3]);
  assert.deepEqual([s.get(1)!.rank, s.get(2)!.rank, s.get(3)!.rank], [1, 2, 3]);
});

test('activity: a 1-hour call counts a lot, and fades over months', () => {
  const today = new Date(2026, 10, 16);
  const call = [{ day: '2026-11-15', messages: 0, calls: 1, call_seconds: 3600 }];
  const texts = [{ day: '2026-11-15', messages: 6, calls: 0, call_seconds: 0 }];
  const fresh = activityScore(call, null, today);
  assert.ok(fresh > 4 && fresh > activityScore(texts, null, today) * 2, `call ${fresh}`);
  const old = activityScore([{ ...call[0], day: '2026-05-15' }], null, today);
  assert.ok(old < fresh / 4, `old ${old}`);
  assert.equal(activityScore([], null, today), 0);
  assert.equal(combineScore(null, 10), 6);
  assert.equal(combineScore(10, 0), 6.5);
});

test('ranking in the database: place, insert above, swap across tiers, scores', async () => {
  const db = fakeDb();
  await migrate(db);
  const a = await createPerson(db, { name: 'A' });
  const b = await createPerson(db, { name: 'B' });
  const c = await createPerson(db, { name: 'C' });
  await placePerson(db, a, 'inner', 0);
  await placePerson(db, b, 'inner', 0); // B above A
  await placePerson(db, c, 'close', 0);
  assert.deepEqual((await listRanking(db)).map((r) => r.person_id), [b, a, c]);
  const rows = await listRanking(db);
  await swapRanking(db, rows[2], rows[1]); // C grew closer than A
  const after = await listRanking(db);
  assert.deepEqual(after.map((r) => [r.person_id, r.tier]), [[b, 'inner'], [c, 'inner'], [a, 'close']]);
  await logInteraction(db, a, '2026-11-15', 60);
  const scores = await loadScores(db, [{ id: a, closeness: 0, last_contacted: null }, { id: b, closeness: 0, last_contacted: null }], new Date(2026, 10, 16));
  assert.equal(scores.get(b)!.feel, 10);
  assert.ok(scores.get(a)!.activity > 4);
  assert.equal((await activitySummary(db, a)).callSecondsAll, 3600);
});

test('Instagram chats: 1:1 only, calls with duration, matched by name or added, re-import replaces', async () => {
  const thread = (folder: string, other: string, msgs: object[]) => ({
    name: `instagram-me.zip › your_instagram_activity/messages/inbox/${folder}/message_1.json`,
    text: JSON.stringify({ participants: [{ name: other }, { name: 'Me Myself' }], messages: msgs }),
  });
  const t = Date.UTC(2026, 10, 10, 18);
  const many = Array.from({ length: 25 }, (_, i) => ({ sender_name: 'Me Myself', timestamp_ms: t + i * 1000, content: 'hi' }));
  const entries = [
    thread('samlee_1', 'Sam Lee', [
      { sender_name: 'Sam Lee', timestamp_ms: t, content: 'yo' },
      { sender_name: 'Sam Lee', timestamp_ms: t + 1, content: 'Audio call ended', call_duration: 3600 },
      { sender_name: 'Me Myself', timestamp_ms: t + 2, content: 'Missed call', call_duration: 0 },
    ]),
    thread('chatty_2', 'Chatty Cathy', many),
    thread('quiet_3', 'Quiet Q', [{ sender_name: 'Quiet Q', timestamp_ms: t, content: 'hey' }]),
    {
      name: 'instagram-me.zip › your_instagram_activity/messages/inbox/group_4/message_1.json',
      text: JSON.stringify({ participants: [{ name: 'A' }, { name: 'B' }, { name: 'Me Myself' }], messages: [{ sender_name: 'A', timestamp_ms: t }] }),
    },
  ];
  const chats = parseChats(entries);
  assert.deepEqual(chats.map((c) => [c.otherName, c.messages, c.calls, c.callSeconds]), [
    ['Sam Lee', 1, 1, 3600],
    ['Chatty Cathy', 25, 0, 0],
    ['Quiet Q', 1, 0, 0],
  ]);

  const db = fakeDb();
  await migrate(db);
  const sam = await createPerson(db, { name: 'Sam Lee' });
  const [r] = await importChats(db, chats);
  assert.deepEqual([r.chats, r.matched, r.created, r.skipped, r.calls], [3, 1, 1, 1, 1]);
  assert.equal((await activitySummary(db, sam)).callSecondsAll, 3600);
  const lc = await db.getFirstAsync('SELECT last_contacted FROM people WHERE id = ?', sam);
  assert.match(lc.last_contacted, /^2026-11-1[01]$/);
  // Importing the same export again must not double-count.
  await importChats(db, parseChats(entries));
  assert.equal((await activitySummary(db, sam)).callSecondsAll, 3600);
  assert.equal((await db.getFirstAsync("SELECT COUNT(*) AS n FROM people WHERE name = 'Chatty Cathy'")).n, 1);
});

test('Discord DMs match friends by user id; server channels ignored', async () => {
  const entries = [
    { name: 'package.zip › Messages/c100/channel.json', text: JSON.stringify({ id: '100', type: 1, recipients: ['me1', 'friend7'] }) },
    {
      name: 'package.zip › Messages/c100/messages.json',
      text: JSON.stringify([{ ID: '1', Timestamp: '2026-11-01 10:00:00', Contents: 'x' }, { ID: '2', Timestamp: '2026-11-01 11:00:00', Contents: 'y' }]),
    },
    { name: 'package.zip › Messages/c200/channel.json', text: JSON.stringify({ id: '200', type: 0, guild: { id: 'g' } }) },
    { name: 'package.zip › Messages/c200/messages.json', text: JSON.stringify([{ ID: '3', Timestamp: '2026-11-01 10:00:00' }]) },
    { name: 'package.zip › Messages/c300/channel.json', text: JSON.stringify({ id: '300', type: 1, recipients: ['me1', 'friend8'] }) },
    { name: 'package.zip › Messages/c300/messages.csv', text: 'ID,Timestamp,Contents,Attachments\n5,2026-10-01 09:00:00.000000+00:00,hi,\n' },
  ];
  const chats = parseChats(entries);
  assert.deepEqual(chats.map((c) => [c.threadId, c.messages]), [['100', 2], ['300', 1]]);
  const db = fakeDb();
  await migrate(db);
  const f = await createPerson(db, { name: 'Friend' });
  await db.runAsync("INSERT INTO sources (person_id, source, external_id, first_seen) VALUES (?, 'discord', 'friend7', 'x')", f);
  const [r] = await importChats(db, chats);
  assert.deepEqual([r.matched, r.skipped], [1, 1]);
  assert.equal((await activitySummary(db, f)).messagesAll, 2);
});
