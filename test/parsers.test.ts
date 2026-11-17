import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixMojibake, fromGooglePeople, isRelevantExportEntry, parseCsv, parseExportFile, parseLinkedInDate, parseMany } from '../src/sync/parsers.ts';

test('parseCsv handles quotes, escaped quotes and CRLF', () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\nd,e,f'), [
    ['a', 'b, c', 'say "hi"'],
    ['d', 'e', 'f'],
  ]);
});

test('LinkedIn Connections.csv with notes preamble', () => {
  const csv = [
    'Notes:',
    '"When exporting your connection data, you may notice that some of the email addresses are missing."',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Ada,Lovelace,https://www.linkedin.com/in/ada,ada@example.com,"Engines, Inc",Analyst,15 Nov 2026',
    'Alan,Turing,https://www.linkedin.com/in/alan,,Bletchley,,03 Feb 2019',
  ].join('\n');
  const r = parseExportFile('Connections.csv', '﻿' + csv);
  assert.equal(r.kind, 'linkedin');
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates[0], {
    source: 'linkedin',
    externalId: 'https://www.linkedin.com/in/ada',
    name: 'Ada Lovelace',
    handle: 'https://www.linkedin.com/in/ada',
    emails: ['ada@example.com'],
    company: 'Engines, Inc',
    title: 'Analyst',
    connectedOn: '2026-11-15',
  });
  assert.equal(r.candidates[1].emails, undefined);
  assert.equal(r.candidates[1].connectedOn, '2019-02-03');
});

test('Instagram followers (array) and following (relationships_ object)', () => {
  const followers = JSON.stringify([
    { title: '', media_list_data: [], string_list_data: [{ href: 'https://www.instagram.com/sam', value: 'sam', timestamp: 1700000000 }] },
  ]);
  const following = JSON.stringify({
    relationships_following: [
      { title: 'kim', string_list_data: [{ href: 'https://www.instagram.com/_u/kim', timestamp: 1700000000 }] },
      { title: 'KIM', string_list_data: [] },
    ],
  });
  const a = parseExportFile('followers_1.json', followers);
  assert.equal(a.kind, 'instagram');
  assert.equal(a.candidates[0].name, 'sam');
  assert.equal(a.candidates[0].handle, '@sam');
  assert.match(a.candidates[0].connectedOn!, /^2023-11-1[45]$/);
  const b = parseExportFile('following.json', following);
  assert.equal(b.kind, 'instagram');
  assert.deepEqual(b.candidates.map((c) => c.name), ['kim']); // de-duplicated case-insensitively
});

test('Facebook friends with mojibake names', () => {
  const json = JSON.stringify({ friends_v2: [{ name: 'JosÃ© PÃ©rez', timestamp: 1500000000 }, { name: 'Bo' }] });
  const r = parseExportFile('your_friends.json', json);
  assert.equal(r.kind, 'facebook');
  assert.deepEqual(r.candidates.map((c) => c.name), ['José Pérez', 'Bo']);
});

test('fixMojibake leaves normal text alone', () => {
  assert.equal(fixMojibake('José'), 'José'); // é alone is not valid UTF-8 continuation → unchanged
  assert.equal(fixMojibake('李雷'), '李雷');
  assert.equal(fixMojibake('plain'), 'plain');
});

test('parseLinkedInDate', () => {
  assert.equal(parseLinkedInDate('1 Jan 2020'), '2020-01-01');
  assert.equal(parseLinkedInDate('garbage'), undefined);
});

test('vCard: iPhone 3.0 export with grouped props, folding, no-year birthday', () => {
  const vcf = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//Apple Inc.//iPhone OS 26.0//EN',
    'N:Lovelace;Ada;;;',
    'FN:Ada Lovelace',
    'ORG:Analytical Engines\\, Ltd;Research',
    'TITLE:Analyst',
    'item1.TEL;type=CELL;type=VOICE;type=pref:+1 (310) 555-0100',
    'EMAIL;type=INTERNET;type=HOME:ada@exam',
    ' ple.com',
    'BDAY;X-APPLE-OMIT-YEAR=1604:1604-12-10',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Turing;Alan;;;',
    'BDAY:1912-06-23',
    'UID:abc-123',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Ada Lovelace',
    'END:VCARD',
  ].join('\r\n');
  const r = parseExportFile('contacts.vcf', vcf);
  assert.equal(r.kind, 'phone');
  assert.deepEqual(r.candidates[0], {
    source: 'phone',
    externalId: 'ada lovelace',
    name: 'Ada Lovelace',
    phones: ['+1 (310) 555-0100'],
    emails: ['ada@example.com'],
    birthday: '12-10',
    company: 'Analytical Engines, Ltd',
    title: 'Analyst',
  });
  assert.equal(r.candidates[1].name, 'Alan Turing');
  assert.equal(r.candidates[1].externalId, 'abc-123');
  assert.equal(r.candidates[1].birthday, '1912-06-23');
  assert.equal(r.candidates[2].externalId, 'ada lovelace#2'); // same name → distinct id
});

test('vCard 2.1 quoted-printable (Android export)', () => {
  const vcf = [
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:P=C3=A9rez;Jos=C3=A9;;;',
    'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 P=C3=A9r=',
    'ez',
    'TEL;CELL:5551234567',
    'END:VCARD',
  ].join('\n');
  const [c] = parseExportFile('00001.vcf', vcf).candidates;
  assert.equal(c.name, 'José Pérez');
  assert.deepEqual(c.phones, ['5551234567']);
});

test('unknown files are rejected', () => {
  assert.throws(() => parseExportFile('x.json', '{"foo": 1}'), /Couldn't recognize/);
  assert.throws(() => parseExportFile('x.csv', 'a,b\n1,2'), /LinkedIn/);
});


test('Discord user.json: friends only, nickname > global name > username', () => {
  const json = JSON.stringify({
    id: 'me',
    username: 'me',
    relationships: [
      { id: '1', type: 1, nickname: 'Bestie', user: { id: '1', username: 'sam', global_name: 'Sam Lee', discriminator: '0' } },
      { id: '2', type: 1, nickname: null, user: { id: '2', username: 'kim', global_name: null, discriminator: '0' } },
      { id: '3', type: 1, user: { id: '3', username: 'old', global_name: 'Old Timer', discriminator: '1234' } },
      { id: '4', type: 2, user: { id: '4', username: 'blocked' } },
      { id: '5', type: 3, user: { id: '5', username: 'pending' } },
    ],
  });
  const r = parseExportFile('user.json', json);
  assert.equal(r.kind, 'discord');
  assert.deepEqual(
    r.candidates.map((c) => [c.externalId, c.name, c.handle]),
    [['1', 'Bestie', '@sam'], ['2', 'kim', '@kim'], ['3', 'Old Timer', '@old#1234']],
  );
});

test('Google People: saved + Gmail other contacts, automated senders dropped', () => {
  const c = fromGooglePeople([
    {
      resourceName: 'people/c1',
      names: [{ displayName: 'Ada Lovelace' }],
      emailAddresses: [{ value: 'ada@example.com' }],
      phoneNumbers: [{ value: '+1 310 555 0100' }],
      birthdays: [{ date: { month: 12, day: 10 } }],
      organizations: [{ name: 'Engines', title: 'CTO' }],
      photos: [{ url: 'https://x/default.png', default: true }],
    },
    { resourceName: 'otherContacts/c2', emailAddresses: [{ value: 'grace@navy.mil' }] },
    { resourceName: 'otherContacts/c3', names: [{ displayName: 'Shop' }], emailAddresses: [{ value: 'no-reply@shop.com' }] },
    { resourceName: 'otherContacts/c4', emailAddresses: [{ value: 'notifications@github.com' }] },
    { resourceName: 'people/c5' },
  ]);
  assert.deepEqual(c.map((x) => x.name), ['Ada Lovelace', 'grace@navy.mil']);
  assert.equal(c[0].birthday, '12-10');
  assert.equal(c[0].photo, undefined);
  assert.equal(c[0].company, 'Engines');
});

test('zip entry filter picks only contact lists', () => {
  const yes = [
    'Connections.csv',
    'connections/followers_and_following/followers_1.json',
    'connections/followers_and_following/following.json',
    'connections/friends/your_friends.json',
    'Account/user.json',
    'package/account/user.json',
    'contacts.vcf',
  ];
  const no = [
    'connections/friends/removed_friends.json',
    'connections/followers_and_following/pending_follow_requests.json',
    'Messages/c123/messages.json',
    'media/photo.jpg',
    'Servers/123/guild.json',
    'user.json',
    'your_instagram_activity/threads/followers.json',
    'your_instagram_activity/threads/following.json',
  ];
  for (const p of yes) assert.ok(isRelevantExportEntry(p), p);
  for (const p of no) assert.ok(!isRelevantExportEntry(p), p);
});

test('parseMany merges files of the same source and de-duplicates', () => {
  const followers = JSON.stringify([{ string_list_data: [{ value: 'sam', timestamp: 1 }] }, { string_list_data: [{ value: 'kim', timestamp: 1 }] }]);
  const following = JSON.stringify({ relationships_following: [{ title: 'sam', string_list_data: [] }, { title: 'lee', string_list_data: [] }] });
  const b = parseMany([
    { name: 'followers_1.json', text: followers },
    { name: 'following.json', text: following },
    { name: 'junk.json', text: '{"x":1}' },
  ]);
  assert.deepEqual(b.bySource.get('instagram')!.map((c) => c.name), ['sam', 'kim', 'lee']);
  assert.equal(b.files.filter((f) => f.error).length, 1);
});

test('city of residence from vCard and Google addresses', async () => {
  const { parseVcards, fromGooglePeople, formatCity } = await import('../src/sync/parsers.ts');
  const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ana Ruiz\r\nitem1.ADR;type=WORK:;;1 Main St;San Diego;ca;92101;USA\r\nitem2.ADR;type=HOME;type=pref:;;12 Elm St;Los Angeles;CA;90024;USA\r\nEND:VCARD';
  assert.equal(parseVcards(card)[0].city, 'Los Angeles, CA');
  assert.equal(fromGooglePeople([{ resourceName: 'people/c1', names: [{ displayName: 'Bo' }], addresses: [{ city: 'Toronto', region: 'Ontario', type: 'home' }] }])[0].city, 'Toronto');
  assert.equal(formatCity('Seattle', 'wa'), 'Seattle, WA');
  assert.equal(formatCity('', 'CA'), undefined);
});

test('Facebook friends in HTML format (current and older layouts)', async () => {
  const { parseExportFile } = await import('../src/sync/parsers.ts');
  const current = `<!DOCTYPE html><html><head><title>Your friends</title><style>.x{}</style></head><body><div class="_a705"><div class="_3-8y _3-95 _a6-g"><div class="_2ph_ _a6-h _a6-i">Ana Ruiz</div><div class="_2ph_ _a6-p"><div><div></div></div></div><div class="_3-94 _a6-o"><div class="_a72d">Apr 03, 2021 7:01:20 pm</div></div></div><div class="_3-8y _3-95 _a6-g"><div class="_2ph_ _a6-h _a6-i">Conan O&#039;Brien</div><div class="_3-94 _a6-o"><div class="_a72d">Dec 9, 2015</div></div></div></div></body></html>`;
  const r = parseExportFile('facebook.zip › connections/friends/your_friends.html', current);
  assert.equal(r.kind, 'facebook');
  assert.deepEqual(r.candidates.map((c) => [c.name, c.connectedOn]), [['Ana Ruiz', '2021-04-03'], ["Conan O'Brien", '2015-12-09']]);
  const older = `<html><body><div class="pam _3-95 _2pi0 _2lej uiBoxWhite noborder"><div class="_3-96 _2pio _2lek _2lel">Bo Chen</div><div class="_3-94 _2lem">Jan 5, 2012</div></div></body></html>`;
  assert.deepEqual(parseExportFile('friends.html', older).candidates.map((c) => [c.name, c.connectedOn]), [['Bo Chen', '2012-01-05']]);
  const oldest = `<html><body><h1>Friends</h1><ul><li>Dee Park (Mar 2, 2010)</li><li>Eli Wu</li></ul></body></html>`;
  assert.deepEqual(parseExportFile('friends.html', oldest).candidates.map((c) => [c.name, c.connectedOn]), [['Dee Park', '2010-03-02'], ['Eli Wu', undefined]]);
});

test('address books from Facebook and Instagram become quiet phone contacts', async () => {
  const { parseExportFile, isRelevantExportEntry } = await import('../src/sync/parsers.ts');
  assert.ok(isRelevantExportEntry('fb.zip › personal_information/other_personal_information/your_address_books.json'));
  assert.ok(isRelevantExportEntry('ig.zip › connections/contacts/synced_contacts.json'));
  const fb = parseExportFile('your_address_books.json', JSON.stringify({ address_book_v2: { address_book: [{ name: 'Mom', details: [{ contact_point: '+1 555 0100' }, { contact_point: 'mom@x.com' }], created_timestamp: 1 }] } }));
  assert.equal(fb.kind, 'phone');
  assert.deepEqual([fb.candidates[0].name, fb.candidates[0].phones, fb.candidates[0].emails, fb.candidates[0].quiet], ['Mom', ['+1 555 0100'], ['mom@x.com'], true]);
  const ig = parseExportFile('synced_contacts.json', JSON.stringify({ contacts_contact_info: [{ string_map_data: { 'First Name': { value: 'Ana' }, 'Last Name': { value: 'Ruiz' }, 'Contact Information': { value: '3105550100' } } }] }));
  assert.deepEqual([ig.kind, ig.candidates[0].name, ig.candidates[0].phones], ['phone', 'Ana Ruiz', ['3105550100']]);
});

test('birthday calendar file', async () => {
  const { birthdaysIcs, turningAge } = await import('../src/lib/birthdays.ts');
  const ics = birthdaysIcs([{ id: 1, name: 'Ana Ruiz', birthday: '1999-03-14' }, { id: 2, name: 'Bo', birthday: '02-29' }, { id: 3, name: 'No Bday', birthday: null }]);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.match(ics, /DTSTART;VALUE=DATE:19990314/);
  assert.match(ics, /RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1/);
  assert.match(ics, /SUMMARY:🎂 Ana Ruiz's birthday/);
  assert.equal(turningAge('1999-03-14', new Date(2026, 10, 17)), 28);
  assert.equal(turningAge('03-14'), null);
});
