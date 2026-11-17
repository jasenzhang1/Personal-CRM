import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeOrganization } from '../src/lib/orgs.ts';

test('spotting organizations vs people', () => {
  for (const org of ['ucla_gsrc', 'journalclub.io', 'electricjungle.ent', 'otoki_global', 'picki_usa_shop', 'Bruin Dance Club', 'lacoffeeco', 'venicerunclub', 'skyblueproteinclub', 'UCLA ACM'])
    assert.ok(looksLikeOrganization(org), org);
  for (const person of ['anna.ucla', 'Jackie Zhang', 'tom_photo', 'amy.travels', 'johnsmith', 'Kelly Li', 'herb_does_comedy', 'eric_y12', 'dance.with.mia', 'brandontvo', 'lo.brandon', 'brandonlcummings'])
    assert.ok(!looksLikeOrganization(person), person);
  assert.ok(looksLikeOrganization('Some Name', ['@cool.bakery']) === false); // a proper name wins over its username
});
