import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appProfileUrl } from '../src/lib/sourceLinks.ts';

test('profile links that open the app on phones', () => {
  assert.equal(appProfileUrl('instagram', 'https://www.instagram.com/jane.doe/', 'ios'), 'instagram://user?username=jane.doe');
  assert.equal(appProfileUrl('linkedin', 'https://www.linkedin.com/in/jane-doe-123/', 'ios'), 'linkedin://in/jane-doe-123');
  assert.equal(appProfileUrl('facebook', 'https://www.facebook.com/jane.doe', 'ios'), 'fb://facewebmodal/f?href=https%3A%2F%2Fwww.facebook.com%2Fjane.doe');
  assert.equal(appProfileUrl('facebook', 'https://www.facebook.com/search/people/?q=Jane', 'ios'), null);
  assert.equal(appProfileUrl('discord', 'https://discord.com/users/12345', 'ios'), null);
  assert.equal(
    appProfileUrl('instagram', 'https://www.instagram.com/jane.doe/', 'android'),
    'intent://www.instagram.com/jane.doe/#Intent;scheme=https;package=com.instagram.android;S.browser_fallback_url=https%3A%2F%2Fwww.instagram.com%2Fjane.doe%2F;end',
  );
  assert.equal(appProfileUrl('phone', 'tel:+15551234567', 'android'), null);
});
