import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_EVERY, nextStep, QUIET_EVERY } from '../src/lib/autoContacts.ts';
import { ago } from '../src/lib/dates.ts';

const now = Date.parse('2026-11-19T12:00:00Z');
const before = (ms: number) => new Date(now - ms).toISOString();

test('nextStep: checks quietly while signed in, at most every few minutes', () => {
  assert.equal(nextStep(null, true, now), 'run');
  assert.equal(nextStep(before(QUIET_EVERY + 1), true, now), 'run');
  assert.equal(nextStep(before(60_000), true, now), 'wait');
});

test('nextStep: without a sign-in, asks for a tap only once a day', () => {
  assert.equal(nextStep(null, false, now), 'ask');
  assert.equal(nextStep(before(3 * 3600_000), false, now), 'wait');
  assert.equal(nextStep(before(ASK_EVERY + 1), false, now), 'ask');
});

test('ago: short relative times', () => {
  assert.equal(ago(null, now), 'never');
  assert.equal(ago(before(10_000), now), 'just now');
  assert.equal(ago(before(5 * 60_000), now), '5 min ago');
  assert.equal(ago(before(3 * 3600_000), now), '3 h ago');
  assert.equal(ago(before(2 * 86400_000), now), '2 days ago');
});
