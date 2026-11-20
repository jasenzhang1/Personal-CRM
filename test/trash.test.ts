import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db/schema.ts';
import { createPerson, deletePeople, getTags, setTags } from '../src/db/people.ts';
import { recordComparison, setPlacement, listRanking, logInteraction } from '../src/db/ranking.ts';
import { copyToTrash, listTrash, purgeTrash, restoreFromTrash } from '../src/db/trash.ts';

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


test('recycle bin: deleting keeps a copy for 30 days, restore brings everything back', async () => {
  const db = fakeDb();
  await migrate(db);
  const a = await createPerson(db, { name: 'Ann Lee', notes: 'met at camp' });
  const b = await createPerson(db, { name: 'Bo Chen' });
  await setTags(db, a, ['camp']);
  await setPlacement(db, a, 7, 0);
  await logInteraction(db, a, '2026-11-01', 60);
  await recordComparison(db, a, b, 'x');

  await deletePeople(db, [a]);
  assert.equal(await db.getFirstAsync('SELECT 1 AS x FROM people WHERE id = ?', a), null, 'gone from People');
  const bin = await listTrash(db);
  assert.deepEqual(bin.map((i) => i.name), ['Ann Lee']);
  assert.equal(bin[0].daysLeft, 29);

  assert.equal(await restoreFromTrash(db, [a]), 1);
  const back = await db.getFirstAsync('SELECT name, notes FROM people WHERE id = ?', a);
  assert.deepEqual({ ...back }, { name: 'Ann Lee', notes: 'met at camp' });
  assert.deepEqual(await getTags(db, a), ['camp']);
  assert.equal((await listRanking(db)).find((r) => r.person_id === a)?.base, 7);
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM interactions WHERE person_id = ?', a))?.n, 1);
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM comparisons'))?.n, 1, 'comparison with Bo restored');
  assert.equal((await listTrash(db)).length, 0, 'out of the bin');
});

test('recycle bin: links to someone also deleted are skipped; old copies expire; delete for good', async () => {
  const db = fakeDb();
  await migrate(db);
  const a = await createPerson(db, { name: 'A' });
  const b = await createPerson(db, { name: 'B' });
  await recordComparison(db, a, b, 'x');
  await deletePeople(db, [a, b]);
  assert.equal(await restoreFromTrash(db, [b]), 1);
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM comparisons'))?.n, 0);

  // 31 days later, A's copy is no longer listed, and the next delete clears it out.
  const later = new Date(Date.now() + 31 * 86_400_000);
  assert.equal((await listTrash(db, later)).length, 0);
  await db.withTransactionAsync(() => copyToTrash(db, [b], later));
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM trash WHERE person_id = ?', a))?.n, 0);

  await purgeTrash(db, [b]);
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM trash'))?.n, 0);
});
