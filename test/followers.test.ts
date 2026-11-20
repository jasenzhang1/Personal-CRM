import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/schema.ts';
import { createPerson, listPeople, setArchived } from '../src/db/people.ts';
import { exportDateOf, followListKind, parseFollowList, recordUnfollowedByMe, syncFollowList } from '../src/sync/igFollows.ts';
import { listFollowAccounts, listFollowEvents } from '../src/db/followers.ts';
import { ingest } from '../src/sync/ingest.ts';
import { parseInstagram } from '../src/sync/parsers.ts';

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

const followers = (...us: string[]) => JSON.stringify(us.map((u) => ({ string_list_data: [{ value: u, href: `https://www.instagram.com/${u}`, timestamp: 1700000000 }] })));
/** Followers with their own follow times, as real exports have: [username, unix seconds]. */
const followersAt = (...us: [string, number][]) => JSON.stringify(us.map(([u, ts]) => ({ string_list_data: [{ value: u, href: `https://www.instagram.com/${u}`, timestamp: ts }] })));
const following = (...us: string[]) => JSON.stringify({ relationships_following: us.map((u) => ({ title: u, string_list_data: [{ href: `https://www.instagram.com/_u/${u}`, timestamp: 1690000000 }] })) });

test('recognizing and parsing follow lists', () => {
  assert.equal(followListKind('ig-2026-11-16.zip › connections/followers_and_following/followers_1.json'), 'followers');
  assert.equal(followListKind('connections/followers_and_following/following.json'), 'following');
  assert.equal(followListKind('your_instagram_activity/threads/followers.json'), null);
  assert.equal(exportDateOf('instagram-jane-2026-11-16-8aSn.zip › connections/x.json'), '2026-11-16');
  assert.deepEqual(parseFollowList(following('Bob.K')).map((e) => [e.username, e.display]), [['bob.k', 'Bob.K']]);
  assert.equal(parseFollowList(followers('amy'))[0].at, '2023-11-14');
});

test('comparing exports finds unfollows, new followers and who does not follow back', async () => {
  const db = fakeDb();
  await migrate(db);
  // First export: the starting point.
  let r = await syncFollowList(db, 'followers', parseFollowList(followers('amy', 'bob', 'cat')), '2026-10-01');
  assert.deepEqual([r.baseline, r.gained, r.lost], [true, 0, 0]);
  await syncFollowList(db, 'following', parseFollowList(following('amy', 'celebrity', 'dan')), '2026-10-01');
  // Newer export: bob unfollowed, eve followed.
  r = await syncFollowList(db, 'followers', parseFollowList(followersAt(['amy', 1700000000], ['cat', 1700000000], ['eve', 1793000000])), '2026-11-16');
  assert.deepEqual([r.baseline, r.gained, r.lost, r.previous], [false, 1, 1, '2026-10-01']);
  // An older export dropped later doesn't undo anything.
  r = await syncFollowList(db, 'followers', parseFollowList(followers('amy', 'bob', 'cat')), '2026-09-01');
  assert.equal(r.older, true);

  const accounts = await listFollowAccounts(db);
  const notBack = accounts.filter((a) => a.i_follow && !a.follows_me).map((a) => a.username).sort();
  assert.deepEqual(notBack, ['celebrity', 'dan']);
  const events = await listFollowEvents(db);
  assert.deepEqual(events.map((e) => [e.kind, e.username, e.after, e.at]), [
    ['unfollowed_me', 'bob', '2026-10-01', '2026-11-16'],
    ['followed_me', 'eve', '2026-10-01', '2026-10-26'],
  ]);
  // Bob follows again in a third export.
  await syncFollowList(db, 'followers', parseFollowList(followers('amy', 'cat', 'eve', 'bob')), '2026-12-20');
  assert.equal((await listFollowAccounts(db)).find((a) => a.username === 'bob')!.follows_me, 1);
  // Instagram's own "you unfollowed" list.
  const mine = parseFollowList(JSON.stringify({ relationships_unfollowed_users: [{ timestamp: 1762000000, label_values: [{ label: 'URL', value: 'https://www.instagram.com/old.pal' }, { label: 'Name', value: 'Old Pal' }, { label: 'Username', value: 'old.pal' }] }] }));
  assert.equal(await recordUnfollowedByMe(db, mine), 1);
  assert.equal(await recordUnfollowedByMe(db, mine), 0);
});

test('follow lists link to people, and archiving hides them', async () => {
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'instagram', parseInstagram(JSON.parse(followers('amy'))));
  await syncFollowList(db, 'followers', parseFollowList(followers('amy')), '2026-11-16');
  const [amy] = await listFollowAccounts(db);
  assert.equal(amy.name, 'amy');
  const club = await createPerson(db, { name: 'UCLA Run Club', how_met: 'Saturday runs' });
  await setArchived(db, [club], true);
  assert.equal((await listPeople(db, { status: ['new', 'backlog', 'reviewed'] })).some((p) => p.id === club), false);
  await setArchived(db, [club], false);
  assert.equal((await listPeople(db)).find((p) => p.id === club)!.status, 'reviewed');
});

test('photo round: Instagram first, missing photos first, done people wait a month', async () => {
  const { photoQueue, markPhotoChecked } = await import('../src/db/photos.ts');
  const db = fakeDb();
  await migrate(db);
  await ingest(db, 'instagram', parseInstagram(JSON.parse(followers('amy.l', 'bo.k'))));
  const { ingest: ing } = await import('../src/sync/ingest.ts');
  await ing(db, 'linkedin', [{ source: 'linkedin', externalId: 'https://www.linkedin.com/in/amyl', name: 'amy.l', handle: 'https://www.linkedin.com/in/amyl' } as any]);
  const cy = await createPerson(db, { name: 'Cy (no links)' });
  let q = await photoQueue(db);
  assert.deepEqual(q.map((p) => [p.name, p.profiles.map((x) => x.source)]), [['amy.l', ['instagram', 'linkedin']], ['bo.k', ['instagram']]]);
  await markPhotoChecked(db, q[0].id, 'data:image/jpeg;base64,xx');
  await markPhotoChecked(db, q[1].id); // no picture to copy
  assert.equal((await photoQueue(db)).length, 0);
  // A month later, refresh mode asks again
  await db.runAsync("UPDATE people SET photo_checked_at = '2020-01-01T00:00:00Z'");
  q = await photoQueue(db, { refresh: true });
  assert.deepEqual(q.map((p) => [p.name, !!p.photo]), [['bo.k', false], ['amy.l', true]]);
  assert.ok(!q.some((p) => p.id === cy));
});

test('photo round opens the same main Instagram as the person page', async () => {
  const { photoQueue } = await import('../src/db/photos.ts');
  const { addInstagramAccount, getSources, setMainInstagram } = await import('../src/db/people.ts');
  const db = fakeDb();
  await migrate(db);
  const id = await createPerson(db, { name: 'Dee' });
  // An old row with no handle (as some imports leave), then two accounts with usernames.
  await db.runAsync("INSERT INTO sources (person_id, source, external_id, handle, first_seen) VALUES (?, 'instagram', 'dee.old', NULL, '2020-01-01')", id);
  await addInstagramAccount(db, id, 'dee.one');
  await addInstagramAccount(db, id, 'dee.two');
  const igUrl = async () => (await photoQueue(db))[0].profiles[0].url;
  // Nothing starred: the person page shows the oldest with a username.
  assert.equal(await igUrl(), 'https://www.instagram.com/dee.one/');
  const two = (await getSources(db, id)).find((s) => s.external_id === 'dee.two')!;
  await setMainInstagram(db, id, two.id);
  assert.equal(await igUrl(), 'https://www.instagram.com/dee.two/');

  // Accounts from the same import share first_seen; both screens must still agree.
  const eli = await createPerson(db, { name: 'Eli' });
  for (const u of ['zed.main', 'amy.alt'])
    await db.runAsync("INSERT INTO sources (person_id, source, external_id, handle, first_seen) VALUES (?, 'instagram', ?, ?, '2026-01-01')", eli, u, '@' + u);
  const pageMain = (await getSources(db, eli)).find((s) => s.handle)!.handle!.slice(1);
  const roundUrl = (await photoQueue(db)).find((p) => p.id === eli)!.profiles[0].url;
  assert.equal(roundUrl, `https://www.instagram.com/${pageMain}/`);
});

test('timeline: who you added each day, from each platform', async () => {
  const { timelineEvents } = await import('../src/db/timeline.ts');
  const db = fakeDb();
  await migrate(db);
  const fol = (u: string, ts: number) => ({ string_list_data: [{ value: u, href: `https://www.instagram.com/${u}`, timestamp: ts }] });
  const followingList = { relationships_following: [{ title: 'amy.lee', string_list_data: [{ href: 'https://www.instagram.com/_u/amy.lee', timestamp: 1763000000 }] }] };
  await ingest(db, 'instagram', parseInstagram([fol('amy.lee', 1763100000), fol('bo.kim', 1700000000)]));
  await syncFollowList(db, 'followers', parseFollowList(JSON.stringify([fol('amy.lee', 1763100000), fol('bo.kim', 1700000000)])), '2026-11-18');
  await syncFollowList(db, 'following', parseFollowList(JSON.stringify(followingList)), '2026-11-18');
  const { ingest: ing } = await import('../src/sync/ingest.ts');
  await ing(db, 'linkedin', [{ source: 'linkedin', externalId: 'https://www.linkedin.com/in/deelin', name: 'Dee Lin', handle: 'https://www.linkedin.com/in/deelin', connectedOn: '2024-03-05' } as any]);
  await createPerson(db, { name: 'Met Today' });
  const ev = await timelineEvents(db);
  const show = ev.map((e) => `${e.day.slice(0, 10)} ${e.kind} ${e.name}`);
  const { isoDate } = await import('../src/lib/dates.ts');
  const local = (ts: number) => isoDate(new Date(ts * 1000)); // days are in your time zone
  assert.ok(show.includes(`${local(1763000000)} ig_followed amy.lee`), show.join('\n'));
  assert.ok(show.includes(`${local(1763100000)} ig_follower amy.lee`), show.join('\n'));
  assert.ok(show.includes(`${local(1700000000)} ig_follower bo.kim`));
  assert.ok(show.includes('2024-03-05 linkedin Dee Lin'));
  assert.ok(ev.some((e) => e.kind === 'manual' && e.name === 'Met Today'));
  assert.ok(!ev.some((e) => e.kind === 'instagram'), 'once follow lists are synced, the precise Instagram dates are used');
});

test('timeline includes every way you connected', async () => {
  const { timelineEvents, firstConnected } = await import('../src/db/timeline.ts');
  const { importChats } = await import('../src/sync/activity.ts');
  const { logInteraction } = await import('../src/db/ranking.ts');
  const { parseDiscord, parseAddressBook } = await import('../src/sync/parsers.ts');
  const db = fakeDb();
  await migrate(db);
  const ana = await createPerson(db, { name: 'Ana Ruiz' });
  // Chats: first message 2025-01-02, first call 2025-03-04 on Instagram
  await importChats(db, [{ source: 'instagram', threadId: 'ana_1', otherName: 'Ana Ruiz', messages: 12, calls: 1, callSeconds: 600,
    days: [{ day: '2025-03-04', messages: 2, calls: 1, call_seconds: 600 }, { day: '2025-01-02', messages: 10, calls: 0, call_seconds: 0 }] } as any]);
  await logInteraction(db, ana, '2026-11-01', 90);
  // Discord friend with a "since" date; an address-book contact with a saved date
  await ingest(db, 'discord', parseDiscord({ relationships: [{ id: '42', type: 1, since: '2021-06-07T10:00:00+00:00', user: { id: '42', username: 'bo' } }] }));
  await ingest(db, 'phone', parseAddressBook({ address_book_v2: { address_book: [{ name: 'Cy Park', details: [{ contact_point: '+15550001' }], created_timestamp: 1500000000 }] } })!);
  const ev = (await timelineEvents(db)).map((e) => `${e.day} ${e.kind}${e.kind === 'first_message' || e.kind === 'first_call' ? ':' + e.source : ''} ${e.name}`);
  assert.ok(ev.includes('2025-01-02 first_message:instagram Ana Ruiz'), ev.join('\n'));
  assert.ok(ev.includes('2025-03-04 first_call:instagram Ana Ruiz'), ev.join('\n'));
  assert.ok(ev.includes('2026-11-01 hangout Ana Ruiz'), ev.join('\n'));
  assert.ok(ev.includes('2021-06-07 discord bo'), ev.join('\n'));
  assert.ok(ev.some((x) => / contact_saved Cy Park$/.test(x) && x.startsWith('2017-07-1')), ev.join('\n'));
  // "New connections" uses each person's first day, not logged hangouts
  const first = firstConnected(await timelineEvents(db));
  assert.equal(first.get(ana), '2025-01-02');
});
