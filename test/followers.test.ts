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
  r = await syncFollowList(db, 'followers', parseFollowList(followers('amy', 'cat', 'eve')), '2026-11-16');
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
    ['followed_me', 'eve', '2026-10-01', '2023-11-14'],
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
