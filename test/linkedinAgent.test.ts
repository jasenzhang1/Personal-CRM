import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { editBytes } from '../agents/lib/dataRepo.ts';
import { importLinkedInZip } from '../agents/linkedin/importArchive.ts';
import { isNew, requestDue } from '../agents/linkedin/schedule.ts';

const csv = (rows: string[]) =>
  ['Notes:', '"Some emails may be missing."', '', 'First Name,Last Name,URL,Email Address,Company,Position,Connected On', ...rows].join('\n');
const archive = (rows: string[]) =>
  zipSync({ 'Connections.csv': strToU8(csv(rows)), 'messages.csv': strToU8('ignored'), 'Profile.csv': strToU8('ignored') });

const ada = 'Ada,Lovelace,https://www.linkedin.com/in/ada,ada@example.com,Engines,Analyst,15 Nov 2026';
const alan = 'Alan,Turing,https://www.linkedin.com/in/alan,,Bletchley,,03 Feb 2019';

const people = async (bytes: Uint8Array) =>
  (await editBytes(bytes, async (db) => ({ changed: false, summary: JSON.stringify(await db.getAllAsync('SELECT name, status FROM people ORDER BY name')) }))).edit.summary;

test('agent imports a LinkedIn archive into the database file, then only new connections reach the Inbox', async () => {
  const first = await editBytes(null, (db) => importLinkedInZip(db, archive([ada])));
  assert.equal(first.edit.changed, true);
  assert.match(first.edit.summary, /1 new → Older connections/);

  const second = await editBytes(first.bytes, (db) => importLinkedInZip(db, archive([ada, alan])));
  assert.match(second.edit.summary, /2 connections · 1 new → Inbox/);

  const again = await editBytes(second.bytes, (db) => importLinkedInZip(db, archive([ada, alan])));
  assert.equal(again.edit.changed, false, 'nothing new → nothing to commit');
  const rows = JSON.parse(await people(second.bytes)) as { name: string; status: string }[];
  assert.deepEqual(rows.map((r) => r.name), ['Ada Lovelace', 'Alan Turing']);
  assert.notEqual(rows[0].status, rows[1].status);
});

test('an archive without Connections.csv is reported, not imported', async () => {
  await assert.rejects(
    editBytes(null, (db) => importLinkedInZip(db, zipSync({ 'Profile.csv': strToU8('x') }), 'part1.zip')),
    /part1\.zip has no Connections\.csv/,
  );
});

test('a new archive is requested once a day, never while one is being prepared', () => {
  const page = { signedOut: false, downloadable: false, pending: false, requestable: true };
  const now = new Date('2026-11-20T09:00:00Z');
  assert.equal(requestDue(page, {}, now, 1), true);
  assert.equal(requestDue(page, { lastRequestAt: '2026-11-19T09:10:00Z' }, now, 1), true, 'a few minutes early still counts');
  assert.equal(requestDue(page, { lastRequestAt: '2026-11-20T02:00:00Z' }, now, 1), false);
  assert.equal(requestDue(page, { lastRequestAt: '2026-11-15T09:00:00Z' }, now, 7), false);
  assert.equal(requestDue({ ...page, pending: true }, {}, now, 1), false);
  assert.equal(requestDue({ ...page, requestable: false }, {}, now, 1), false);
  assert.equal(requestDue({ ...page, signedOut: true }, {}, now, 1), false);
});

test('archives already imported are skipped', () => {
  assert.equal(isNew('abc', { imported: ['abc'] }), false);
  assert.equal(isNew('def', { imported: ['abc'] }), true);
  assert.equal(isNew('abc', {}), true);
});
