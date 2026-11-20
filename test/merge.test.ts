import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/schema.ts';
import { ingest } from '../src/sync/ingest.ts';
import { parseInstagram } from '../src/sync/parsers.ts';
import { importChats } from '../src/sync/activity.ts';
import { createPerson, getTags, setTags } from '../src/db/people.ts';
import { dismissDuplicate, listDuplicates, mergePeople, splitAccounts } from '../src/db/merge.ts';
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
    P(8, 'Kevin Lee', 'kevin.lee.2'), // same name, different Instagram accounts â†’ weak
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
  // A contact and their chat first, the Instagram follower later: the case the import can't prevent.
  await createPerson(db, { name: 'Jackie Zhang' });
  const chat = { source: 'instagram', threadId: 'jz_999', otherName: 'Jackie Zhang', messages: 30, calls: 1, callSeconds: 600, days: [{ day: '2026-11-10', messages: 30, calls: 1, call_seconds: 600 }] } as any;
  await importChats(db, [chat]);
  await ingest(db, 'instagram', parseInstagram([follower('jackiezhang26')]));
  const all = await db.getAllAsync('SELECT id, name FROM people ORDER BY id');
  const [chatPerson, ig] = all.map((r: any) => r.id);
  await db.runAsync("UPDATE people SET notes = 'Met at UCLA', birthday = '03-14' WHERE id = ?", chatPerson);
  await db.runAsync("UPDATE people SET notes = 'Loves boba', status = 'reviewed' WHERE id = ?", ig);
  await setTags(db, ig, ['UCLA']);
  await setTags(db, chatPerson, ['ucla', 'Climbing']);
  await setPlacement(db, chatPerson, 8.5, 3);
  await logInteraction(db, ig, '2026-11-10', 30);

  const pairs = await listDuplicates(db);
  assert.deepEqual(pairs.map((p) => [p.a, p.b, p.reason]), [[chatPerson, ig, 'username']]);

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

test('linking an Instagram account by hand', async () => {
  const { addInstagramAccount, parseInstagramUsername, listPeople } = await import('../src/db/people.ts');
  assert.equal(parseInstagramUsername('@jane.doe'), 'jane.doe');
  assert.equal(parseInstagramUsername('https://www.instagram.com/jane.doe/?hl=en'), 'jane.doe');
  assert.equal(parseInstagramUsername('instagram.com/_u/Jane_Doe'), 'Jane_Doe');
  assert.equal(parseInstagramUsername('jane doe'), null);
  const db = fakeDb();
  await migrate(db);
  const jane = await createPerson(db, { name: 'Jane Doe' });
  const bob = await createPerson(db, { name: 'Bob' });
  assert.deepEqual(await addInstagramAccount(db, jane, 'instagram.com/Jane.Doe'), { ok: true, username: 'Jane.Doe' });
  assert.equal((await listPeople(db)).find((p) => p.id === jane)!.ig_handle, 'Jane.Doe');
  const clash = await addInstagramAccount(db, bob, '@jane.doe');
  assert.equal(clash.ok, false);
  assert.equal((clash as any).otherId, jane);
  // A later Instagram import matches her instead of adding a new person.
  const follower = (u: string) => ({ string_list_data: [{ value: u, href: `https://www.instagram.com/${u}`, timestamp: 1700000000 }] });
  await ingest(db, 'instagram', parseInstagram([follower('jane.doe')]));
  assert.equal((await listPeople(db)).length, 2);
});

test('an Instagram chat attaches to its follower instead of creating a second person', async () => {
  const db = fakeDb();
  await migrate(db);
  const follower = (u: string) => ({ string_list_data: [{ value: u, href: `https://www.instagram.com/${u}`, timestamp: 1700000000 }] });
  await ingest(db, 'instagram', parseInstagram([follower('jackiezhang26'), follower('zd_77'), follower('kevinlee1'), follower('kevin.lee.2')]));
  await db.runAsync("UPDATE sources SET display_name = 'Zoe Deng' WHERE external_id = 'zd_77'"); // from Close Friends
  const chat = (threadId: string, otherName: string, n = 30) =>
    ({ source: 'instagram', threadId, otherName, messages: n, calls: 0, callSeconds: 0, days: [{ day: '2026-11-10', messages: n, calls: 0, call_seconds: 0 }] }) as any;
  const [r] = await importChats(db, [chat('jz_1', 'Jackie Zhang'), chat('zoe_2', 'Zoe Deng', 3), chat('kl_3', 'Kevin Lee')]);
  assert.equal(r.linkedToFollower, 2); // Jackie by username, Zoe by her Instagram name (even a small chat)
  assert.equal(r.created, 0); // two Kevin Lee accounts: too ambiguous, so the chat is skipped (chats never add people)
  assert.equal(r.skipped, 1);
  const names = (await db.getAllAsync('SELECT name FROM people')).map((x: any) => x.name).sort((x: string, y: string) => x.localeCompare(y));
  assert.deepEqual(names, ['jackiezhang26', 'kevin.lee.2', 'kevinlee1', 'zd_77'].sort((x, y) => x.localeCompare(y)));
  const jz = await db.getFirstAsync("SELECT SUM(i.messages) m FROM interactions i JOIN sources s ON s.person_id = i.person_id WHERE s.external_id = 'jackiezhang26'");
  assert.equal(jz.m, 30);
});

test('merge all likely: skips anyone matching more than one person', async () => {
  const { mergeAllLikely } = await import('../src/db/merge.ts');
  const db = fakeDb();
  await migrate(db);
  const follower = (u: string) => ({ string_list_data: [{ value: u, href: `https://www.instagram.com/${u}`, timestamp: 1700000000 }] });
  await ingest(db, 'instagram', parseInstagram([follower('amytran99'), follower('kevinlee1'), follower('kevin.lee.2')]));
  await createPerson(db, { name: 'Amy Tran', notes: 'Roommate' });
  await createPerson(db, { name: 'Kevin Lee' });
  const before = (await listDuplicates(db)).filter((p) => p.strong).length;
  assert.equal(before, 3);
  assert.deepEqual(await mergeAllLikely(db), { merged: 1, skipped: 2 });
  const amy = await db.getAllAsync("SELECT p.name, p.notes, s.external_id FROM people p JOIN sources s ON s.person_id = p.id WHERE p.name LIKE 'Amy%'");
  assert.deepEqual(amy.map((x: any) => [x.name, x.notes, x.external_id]), [['Amy Tran', 'Roommate', 'amytran99']]);
  assert.equal((await listDuplicates(db)).filter((p) => p.strong).length, 2); // the Kevin pairs are still there to check
});

test('people with no contact or profile link are found for removal; a typed-in phone keeps someone', async () => {
  const { unlinkedPeople, deletePeople } = await import('../src/db/people.ts');
  const db = fakeDb();
  await migrate(db);
  // Older versions created these from busy chats.
  const t = new Date().toISOString();
  const mk = async (name: string, thread: string) => {
    const id = (await db.runAsync("INSERT INTO people (name, status, created_at, updated_at) VALUES (?, 'backlog', ?, ?)", name, t, t)).lastInsertRowId;
    await db.runAsync("INSERT INTO sources (person_id, source, external_id, first_seen) VALUES (?, 'instagram', ?, ?)", id, 'chat:' + thread, t);
    return id;
  };
  const plain = await mk('Chat Only', 'c_1');
  const noted = await mk('Chat With Notes', 'c_2');
  await db.runAsync("UPDATE people SET notes = 'met at a party' WHERE id = ?", noted);
  const ranked = await mk('Chat Ranked', 'c_3');
  await setPlacement(db, ranked, 7, 2);
  const follower = await createPerson(db, { name: 'Real Follower' });
  await db.runAsync("INSERT INTO sources (person_id, source, external_id, handle, first_seen) VALUES (?, 'instagram', 'real.f', '@real.f', ?)", follower, t);
  await db.runAsync("INSERT INTO sources (person_id, source, external_id, first_seen) VALUES (?, 'instagram', 'chat:c_4', ?)", follower, t);
  const bare = await createPerson(db, { name: 'Typed In, Nothing Else' });
  const withPhone = await createPerson(db, { name: 'Typed In With Phone' });
  await db.runAsync("UPDATE people SET phone = '3105550100' WHERE id = ?", withPhone);
  const r = await unlinkedPeople(db);
  assert.deepEqual(r.sort(), [plain, noted, ranked, bare].sort());
  await deletePeople(db, r);
  assert.deepEqual((await db.getAllAsync('SELECT name FROM people ORDER BY id')).map((x: any) => x.name), ['Real Follower', 'Typed In With Phone']);
  assert.equal((await db.getFirstAsync("SELECT COUNT(*) n FROM sources WHERE external_id = 'chat:c_1'")).n, 0);
});

test('nicknames: an English name matches a legal/Chinese name, and merging two real names keeps the other as a nickname', async () => {
  const pairs = findDuplicates([
    P(1, 'Wei Zhang', undefined, { nickname: 'David' }),
    P(2, 'David Zhang', 'davidzhang99'),
    P(3, 'Xiaoming Li', undefined, { nickname: 'Sean Li' }),
    P(4, 'seanli', 'seanli'),
  ]);
  const has = (a: number, b: number) => pairs.find((p) => p.a === a && p.b === b);
  assert.equal(has(1, 2)?.strong, true);
  assert.ok(has(3, 4));

  const db = fakeDb();
  await migrate(db);
  const keep = await createPerson(db, { name: 'Wei Zhang' });
  const drop = await createPerson(db, { name: 'David Zhang' });
  await mergePeople(db, keep, drop);
  assert.deepEqual(await db.getFirstAsync('SELECT name, nickname FROM people WHERE id = ?', keep), { name: 'Wei Zhang', nickname: 'David' });

  const { listPeople } = await import('../src/db/people.ts');
  assert.deepEqual((await listPeople(db, { search: 'david' })).map((p) => p.name), ['Wei Zhang']);

  const a = await createPerson(db, { name: 'Kevin Lee' });
  const b = await createPerson(db, { name: 'Kevin Li' });
  await mergePeople(db, a, b);
  assert.equal((await db.getFirstAsync('SELECT nickname FROM people WHERE id = ?', a)).nickname, null);
});

test('Facebook friend-links file: real profile links replace the name search, matched by name', async () => {
  const { sourceLinks } = await import('../src/lib/sourceLinks.ts');
  const { getSources } = await import('../src/db/people.ts');
  const { parseFacebook, parseExportFile, parseMany, parseFacebookUrl, FB_LINKS_MARK } = await import('../src/sync/parsers.ts');
  assert.equal(parseFacebookUrl('https://m.facebook.com/jane.doe?ref=bookmarks'), 'https://www.facebook.com/jane.doe');
  assert.equal(parseFacebookUrl('facebook.com/profile.php?id=100012345678'), 'https://www.facebook.com/profile.php?id=100012345678');
  assert.equal(parseFacebookUrl('jane.doe'), null);

  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'facebook', parseFacebook({ friends_v2: [{ name: 'Jane Doe', timestamp: 1600000000 }, { name: 'Bob Ng', timestamp: 1600000000 }] }));
  const jane = (await db.getFirstAsync("SELECT id FROM people WHERE name = 'Jane Doe'")).id;
  assert.match(sourceLinks(await getSources(db, jane)).facebook!, /search/);

  const file = JSON.stringify({ kind: FB_LINKS_MARK, friends: [{ name: 'Jane Doe', url: 'https://www.facebook.com/jane.doe.77' }, { name: 'Bob Ng', url: 'https://www.facebook.com/profile.php?id=42' }] });
  const r = parseExportFile('facebook_friend_links.json', file);
  assert.equal(r.kind, 'facebook');
  const res = await ingest(db, 'facebook', r.candidates);
  assert.equal(res.added, 0);
  assert.equal(res.maybeRenamed, 0);
  assert.equal((await db.getFirstAsync('SELECT COUNT(*) n FROM people')).n, 2);
  assert.equal(sourceLinks(await getSources(db, jane)).facebook, 'https://www.facebook.com/jane.doe.77');

  // Dropped together with the official export, the links still come through.
  const both = parseMany([
    { name: 'your_friends.json', text: JSON.stringify({ friends_v2: [{ name: 'Amy Tran', timestamp: 1600000000 }] }) },
    { name: 'facebook_friend_links.json', text: JSON.stringify({ kind: FB_LINKS_MARK, friends: [{ name: 'Amy Tran', url: 'https://facebook.com/amy.t' }] }) },
  ]).bySource.get('facebook')!;
  assert.deepEqual(both.map((c) => [c.handle, c.connectedOn]), [['https://www.facebook.com/amy.t', '2020-09-13']]);
});

test('splitting off a wrongly merged Instagram makes it its own person again', async () => {
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'instagram', parseInstagram([{ string_list_data: [{ value: 'their.account' }] }, { string_list_data: [{ value: 'wrong.account' }] }]));
  const ids = (await db.getAllAsync('SELECT person_id, external_id FROM sources')) as { person_id: number; external_id: string }[];
  const person = ids.find((r) => r.external_id === 'their.account')!.person_id;
  const other = ids.find((r) => r.external_id === 'wrong.account')!.person_id;
  await db.runAsync("UPDATE people SET phone = '555-0100' WHERE id = ?", person);
  await db.runAsync("INSERT INTO sources (person_id, source, external_id, handle, first_seen) VALUES (?, 'linkedin', 'https://www.linkedin.com/in/someone', 'https://www.linkedin.com/in/someone', '2026-01-01')", person);
  await mergePeople(db, person, other);
  // A chat that came along with the wrong merge.
  await db.runAsync("INSERT INTO sources (person_id, source, external_id, first_seen) VALUES (?, 'instagram', 'chat:x_1', '2026-01-01')", person);
  await db.runAsync("INSERT INTO interactions (person_id, day, source, messages) VALUES (?, '2026-02-01', 'instagram', 3)", person);

  // With another Instagram still on them, chats stay put.
  const wrong = (await db.getAllAsync("SELECT id FROM sources WHERE external_id = 'wrong.account'")) as { id: number }[];
  const n1 = await splitAccounts(db, person, wrong.map((r) => r.id), 'Someone Else');
  const where = async (ext: string) => ((await db.getFirstAsync('SELECT person_id FROM sources WHERE external_id = ?', ext)) as { person_id: number }).person_id;
  assert.equal(await where('wrong.account'), n1);
  assert.equal(await where('their.account'), person);
  assert.equal(await where('chat:x_1'), person);
  assert.equal(((await db.getFirstAsync('SELECT name, phone FROM people WHERE id = ?', n1)) as any).name, 'Someone Else');
  assert.equal(((await db.getFirstAsync('SELECT phone FROM people WHERE id = ?', person)) as any).phone, '555-0100');
  // Not suggested as duplicates again.
  assert.ok(!(await listDuplicates(db)).some((d) => [d.a, d.b].includes(n1) && [d.a, d.b].includes(person)));

  // Splitting their last Instagram takes the Instagram chats and message history with it; LinkedIn stays.
  const real = (await db.getAllAsync("SELECT id FROM sources WHERE external_id = 'their.account'")) as { id: number }[];
  const n2 = await splitAccounts(db, person, real.map((r) => r.id), 'their.account');
  assert.equal(await where('chat:x_1'), n2);
  assert.equal(await where('https://www.linkedin.com/in/someone'), person);
  assert.equal(((await db.getFirstAsync("SELECT COUNT(*) AS n FROM interactions WHERE person_id = ?", n2)) as any).n, 1);
});
