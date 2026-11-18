import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/schema.ts';
import { createPerson } from '../src/db/people.ts';
import { activitySummary, listRanking, loadScores, logInteraction, removeRanking, setPlacement } from '../src/db/ranking.ts';
import { activityScore, assignRanks, cyclePairs, findCycle, fitWeb, normalizeComparison, pairKey, pickPair, scoreInfo } from '../src/lib/ranking.ts';
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

/** A seeded random number generator, so the mixing tests are repeatable. */
function seeded(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('the web: one answer flips two people, answers propagate to people never compared directly', () => {
  const priors = new Map([[1, 3], [2, 7], [3, 5]]);
  // Closer to 1 than 2 (activity had it the other way round).
  let s = fitWeb(priors, [normalizeComparison(1, 2, 'x')]);
  assert.ok(s.get(1)! > s.get(2)!, `flip ${[...s]}`);
  // Then 2 over 3: 1 > 2 > 3, and 3 drops though it was never compared with 1.
  s = fitWeb(priors, [normalizeComparison(1, 2, 'x'), normalizeComparison(2, 3, 'x')]);
  assert.ok(s.get(1)! > s.get(2)! && s.get(2)! > s.get(3)!, `chain ${[...s]}`);
  // "About the same" pulls two together.
  const t = fitWeb(new Map([[1, 2], [2, 8]]), [normalizeComparison(1, 2, 'tie')]);
  assert.ok(Math.abs(t.get(1)! - t.get(2)!) < 2, `tie ${[...t]}`);
  // Scores stay on the 0–10 scale.
  const many = fitWeb(new Map([[1, 9.5], [2, 0.5], [3, 0.5], [4, 0.5]]), [2, 3, 4].map((o) => normalizeComparison(1, o, 'x')));
  for (const v of many.values()) assert.ok(v >= 0 && v <= 10);
});

test('the web: circles are found and point at the answers to re-ask', () => {
  const comps = [normalizeComparison(1, 2, 'x'), normalizeComparison(2, 3, 'x')];
  assert.equal(findCycle([...comps, normalizeComparison(1, 3, 'x')], 1, 3), null);
  const loop = findCycle([...comps, normalizeComparison(3, 1, 'x')], 3, 1);
  assert.deepEqual(loop, [3, 1, 2]);
  assert.deepEqual(cyclePairs(loop!), [[3, 1], [1, 2], [2, 3]]);
  // "About the same" never makes a circle.
  assert.equal(findCycle([...comps, normalizeComparison(3, 1, 'tie')], 1, 2), null);
  // A longer one.
  const long = [normalizeComparison(1, 2, 'x'), normalizeComparison(2, 3, 'x'), normalizeComparison(3, 4, 'x'), normalizeComparison(4, 1, 'x')];
  assert.deepEqual(findCycle(long, 4, 1), [4, 1, 2, 3]);
});

test('the web: pairs are mixed widely, not the same few people over and over', () => {
  const cands = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, score: 1 + (i % 90) / 10, n: 0 }));
  const rng = seeded(7);
  const seen = new Map<number, number>();
  const asked = new Set<string>();
  let recent: number[] = [];
  for (let q = 0; q < 100; q++) {
    const pair = pickPair(cands, { asked, recent, rng })!;
    assert.notEqual(pair[0], pair[1]);
    assert.ok(!asked.has(pairKey(...pair)), 'never repeats a pair');
    assert.ok(!recent.includes(pair[0]) && !recent.includes(pair[1]), 'nobody from the last few questions');
    asked.add(pairKey(...pair));
    recent = [...pair, ...recent].slice(0, 8);
    for (const id of pair) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
      cands[id - 1].n++;
    }
  }
  assert.ok(seen.size > 120, `only ${seen.size} different people in 100 questions`);
  assert.ok(Math.max(...seen.values()) <= 4, `someone came up ${Math.max(...seen.values())} times`);

  // Ranking one person: they're in every question, against different people each time.
  const opponents = new Set<number>();
  const fa = new Set<string>();
  for (let q = 0; q < 7; q++) {
    const pair = pickPair(cands, { asked: fa, recent: [], focus: 50, focusAsked: q, rng })!;
    assert.ok(pair.includes(50));
    fa.add(pairKey(...pair));
    opponents.add(pair[0] === 50 ? pair[1] : pair[0]);
  }
  assert.equal(opponents.size, 7);
});

test('the web: pairs are always people close in score', () => {
  const cands = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, score: 1 + (i % 90) / 10, n: 0 }));
  const rng = seeded(11);
  const asked = new Set<string>();
  let recent: number[] = [];
  const score = (id: number) => cands[id - 1].score;
  for (let q = 0; q < 200; q++) {
    const pair = pickPair(cands, { asked, recent, rng })!;
    const gap = Math.abs(score(pair[0]) - score(pair[1]));
    assert.ok(gap <= 0.75 + 1e-9, `asked about two people ${gap.toFixed(2)} apart`);
    asked.add(pairKey(...pair));
    recent = [...pair, ...recent].slice(0, 8);
    for (const id of pair) cands[id - 1].n++;
  }
});

test('the web in the database: answers saved once per pair, refit moves scores, merge and not-close clean up', async () => {
  const { recordComparison, refitWeb, listComparisons } = await import('../src/db/ranking.ts');
  const { mergePeople } = await import('../src/db/merge.ts');
  const db = fakeDb();
  await migrate(db);
  const [a, b, c, d] = [await createPerson(db, { name: 'A' }), await createPerson(db, { name: 'B' }), await createPerson(db, { name: 'C' }), await createPerson(db, { name: 'D' })];
  const people = [a, b, c, d].map((id) => ({ id, closeness: 0, last_contacted: null }));
  await setPlacement(db, a, 3, 0);
  await setPlacement(db, b, 7, 0);
  let s = await loadScores(db, people);
  await recordComparison(db, b, a, 'y'); // closer to A
  await refitWeb(db, s, [a, b]);
  s = await loadScores(db, people);
  assert.ok(s.get(a)!.score > s.get(b)!.score, 'A now above B');
  await recordComparison(db, a, b, 'y'); // changed my mind: B
  assert.equal((await listComparisons(db)).length, 1);
  await refitWeb(db, s, [a, b]);
  s = await loadScores(db, people);
  assert.ok(s.get(b)!.score > s.get(a)!.score, 'answering again replaces the old answer');

  // C (no score yet) beats B: C enters the web from its guess (0) and climbs.
  await recordComparison(db, c, b, 'x');
  await refitWeb(db, s, [b, c]);
  s = await loadScores(db, people);
  assert.ok(s.get(c)!.placed && s.get(c)!.score > 3, `C ${s.get(c)!.score}`);

  // Merging D into C keeps C's answers; D's answer against A moves over.
  await recordComparison(db, d, a, 'x');
  await mergePeople(db, c, d);
  const comps = await listComparisons(db);
  assert.ok(comps.some((x) => x.a === Math.min(a, c) && x.b === Math.max(a, c)));
  assert.ok(!comps.some((x) => x.a === d || x.b === d));

  // Not close anymore: their answers are forgotten so they stay at 0.
  await setPlacement(db, c, 0, 0);
  assert.ok(!(await listComparisons(db)).some((x) => x.a === c || x.b === c));
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

test('setting a score by hand sticks exactly, and forgets old comparisons so a refit cannot undo it', async () => {
  const { recordComparison, refitWeb, listComparisons, setScoreByHand } = await import('../src/db/ranking.ts');
  const db = fakeDb();
  await migrate(db);
  const [a, b, c] = [await createPerson(db, { name: 'A' }), await createPerson(db, { name: 'B' }), await createPerson(db, { name: 'C' })];
  const people = [a, b, c].map((id) => ({ id, closeness: 0, last_contacted: null }));
  await setPlacement(db, a, 5, 0);
  await setPlacement(db, b, 5, 0);
  await setPlacement(db, c, 5, 0);
  let s = await loadScores(db, people);
  await recordComparison(db, a, b, 'x');
  await recordComparison(db, b, c, 'x');
  await refitWeb(db, s, [a, b, c]);
  await setScoreByHand(db, b, 9.25, 0);
  assert.deepEqual((await listComparisons(db)).length, 0, "B's answers are forgotten");
  s = await loadScores(db, people);
  assert.equal(s.get(b)!.score, 9.25);
  assert.ok(s.get(b)!.placed);
  await setScoreByHand(db, c, 14, 0);
  assert.equal((await loadScores(db, people)).get(c)!.score, 10, 'clamped to 10');
});
