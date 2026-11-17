import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/schema.ts';
import { createPerson } from '../src/db/people.ts';
import { activitySummary, listRanking, loadScores, logInteraction, removeRanking, setPlacement } from '../src/db/ranking.ts';
import { activityScore, answerPlacement, assignRanks, nextOpponent, nextToPlace, placedScore, scoreInfo, startPlacement, type Placement } from '../src/lib/ranking.ts';
import { parseChats } from '../src/sync/messages.ts';
import { importChats } from '../src/sync/activity.ts';

function fakeDb(d = new DatabaseSync(':memory:')) {
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

/** Simulate answering truthfully against a hidden "true" order (lower number = closer). */
function place(personId: number, others: number[]) {
  // Existing scores: evenly spread, closest first.
  const ladder = others.map((id, i) => ({ id, score: Math.round((10 - (9 * i) / Math.max(others.length - 1, 1)) * 10) / 10 }));
  let p: Placement = startPlacement(personId, ladder);
  let asked = 0;
  for (let o = nextOpponent(p); o !== null; o = nextOpponent(p)) {
    asked++;
    p = answerPlacement(p, personId < o ? 'new' : 'other');
  }
  return { index: p.lo, asked, score: placedScore(p), ladder };
}

test('binary-search placement finds the right spot in few questions, score between neighbours', () => {
  const others = Array.from({ length: 64 }, (_, i) => i + 1).filter((x) => x !== 40);
  const { index, asked, score, ladder } = place(40, others);
  assert.equal(index, 39);
  assert.ok(asked <= 6, `asked ${asked}`);
  assert.ok(score < ladder[38].score && score > ladder[39].score, `score ${score}`);
  assert.ok(place(0, others).score > ladder[0].score - 0.01); // closest of all → top
  assert.ok(place(99, others).score < ladder.at(-1)!.score); // least close → bottom
});

test('"about the same" takes that person\'s score', () => {
  const p = startPlacement(9, [{ id: 1, score: 9 }, { id: 2, score: 6.5 }, { id: 3, score: 2 }]);
  assert.equal(nextOpponent(p), 2);
  const done = answerPlacement(p, 'tie');
  assert.equal(nextOpponent(done), null);
  assert.equal(placedScore(done), 6.5);
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
});

test('scores: estimate from activity, placed scores drift with activity, order always matches score', () => {
  assert.equal(scoreInfo({ hearts: 0, activity: 6.2 }).score, 6.2);
  assert.equal(scoreInfo({ hearts: 5, activity: 1 }).score, 9);
  const row = { person_id: 1, base: 8, act_at: 6, ranked_at: '2026-11-01' };
  const quiet = scoreInfo({ row, hearts: 0, activity: 0 });
  assert.equal(quiet.score, 5);
  assert.ok(quiet.drifting);
  const closer = scoreInfo({ row, hearts: 0, activity: 10 });
  assert.equal(closer.score, 10);
  assert.ok(closer.growing);
  const m = new Map([[1, quiet], [2, scoreInfo({ hearts: 0, activity: 7 })], [3, scoreInfo({ hearts: 0, activity: 0 })]]);
  assert.deepEqual(assignRanks(m), [2, 1]);
  assert.equal(m.get(3)!.rank, undefined);
});

test('the game asks about high guesses first, then people whose score moved', () => {
  const today = new Date(2026, 10, 16);
  const fresh = { person_id: 0, base: 7, act_at: 5, ranked_at: '2026-11-15T00:00:00Z' };
  const scores = new Map([
    [1, scoreInfo({ row: { ...fresh, person_id: 1 }, hearts: 0, activity: 5 })], // placed yesterday, unchanged
    [2, scoreInfo({ hearts: 0, activity: 3 })], // guess
    [3, scoreInfo({ hearts: 0, activity: 8 })], // bigger guess
    [4, scoreInfo({ row: { ...fresh, person_id: 4 }, hearts: 0, activity: 0 })], // went quiet: drift −2.5
    [5, scoreInfo({ hearts: 0, activity: 0 })], // nothing to go on
  ]);
  assert.equal(nextToPlace(scores, new Set(), today), 3);
  assert.equal(nextToPlace(scores, new Set([3]), today), 4);
  assert.equal(nextToPlace(scores, new Set([3, 4]), today), 2);
  assert.equal(nextToPlace(scores, new Set([3, 4, 2]), today), 1);
  assert.equal(nextToPlace(scores, new Set([1, 2, 3, 4]), today), null);
});

test('ranking in the database: place, drift after a call, not close anymore, back to guess', async () => {
  const db = fakeDb();
  await migrate(db);
  const a = await createPerson(db, { name: 'A' });
  const b = await createPerson(db, { name: 'B' });
  const today = new Date(2026, 10, 16);
  const people = [{ id: a, closeness: 0, last_contacted: null }, { id: b, closeness: 0, last_contacted: null }];
  await setPlacement(db, a, 6, 0);
  await setPlacement(db, b, 9, 0);
  let s = await loadScores(db, people, today);
  assert.deepEqual([s.get(b)!.rank, s.get(a)!.rank], [1, 2]);
  await logInteraction(db, a, '2026-11-15', 60); // a long call with A
  s = await loadScores(db, people, today);
  assert.ok(s.get(a)!.score > 6 && s.get(a)!.drift > 0, `after call ${s.get(a)!.score}`);
  assert.equal((await activitySummary(db, a)).callSecondsAll, 3600);
  await setPlacement(db, b, 0, 0); // broke up
  s = await loadScores(db, people, today);
  assert.equal(s.get(b)!.score, 0);
  assert.equal(s.get(a)!.rank, 1);
  await removeRanking(db, a);
  s = await loadScores(db, people, today);
  assert.equal(s.get(a)!.placed, false);
  assert.equal(s.get(a)!.score, s.get(a)!.activity);
});

test('migration keeps old tier rankings in order as scores from 10 down', async () => {
  const d = new DatabaseSync(':memory:');
  const db = fakeDb(d);
  await migrate(db);
  const ids = [];
  for (const n of ['In1', 'In2', 'Close1', 'Casual1']) ids.push(await createPerson(db, { name: n }));
  // Rebuild the old v3 table and pretend we're on v3.
  d.exec(`DROP TABLE rankings; CREATE TABLE rankings (person_id INTEGER PRIMARY KEY, tier TEXT NOT NULL, pos INTEGER NOT NULL, ranked_at TEXT NOT NULL);
    INSERT INTO rankings VALUES (${ids[3]}, 'casual', 0, 't'), (${ids[2]}, 'close', 0, 't'), (${ids[1]}, 'inner', 1, 't'), (${ids[0]}, 'inner', 0, 't');
    PRAGMA user_version = 3;`);
  await migrate(db);
  const rows = (await listRanking(db)).sort((x, y) => y.base - x.base);
  assert.deepEqual(rows.map((r) => r.person_id), ids);
  assert.deepEqual(rows.map((r) => r.base), [10, 7, 4, 1]);
  assert.equal(rows[0].act_at, null);
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
  assert.deepEqual([r.chats, r.matched, r.created, r.skipped, r.calls], [3, 1, 0, 2, 1]); // chats never add people
  assert.equal((await activitySummary(db, sam)).callSecondsAll, 3600);
  const lc = await db.getFirstAsync('SELECT last_contacted FROM people WHERE id = ?', sam);
  assert.match(lc.last_contacted, /^2026-11-1[01]$/);
  // Importing the same export again must not double-count.
  await importChats(db, parseChats(entries));
  assert.equal((await activitySummary(db, sam)).callSecondsAll, 3600);
  assert.equal((await db.getFirstAsync("SELECT COUNT(*) AS n FROM people WHERE name = 'Chatty Cathy'")).n, 0);
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
