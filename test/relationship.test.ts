import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferCircle } from '../src/lib/relationship.ts';
import { parseVcards, vcardPhoto } from '../src/sync/parsers.ts';

test('inferCircle: LinkedIn/pipeline = professional, social = personal, both = both', () => {
  assert.equal(inferCircle(['linkedin'], false), 'professional');
  assert.equal(inferCircle(['phone'], true), 'professional');
  assert.equal(inferCircle(['instagram', 'phone'], false), 'personal');
  assert.equal(inferCircle(['instagram', 'linkedin'], false), 'both');
  assert.equal(inferCircle(['phone', 'google'], false), null);
});


test('vCard photos: iPhone base64, vCard 4 data URI, URLs; junk ignored', () => {
  const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Ada', 'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ', ' SkZJRg==', 'END:VCARD'].join('\r\n');
  assert.equal(parseVcards(vcf)[0].photo, 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  assert.equal(vcardPhoto('data:image/png;base64,iVBO', 'VALUE=uri'), 'data:image/png;base64,iVBO');
  assert.equal(vcardPhoto('iVBORw0K', 'ENCODING=BASE64;PNG'), 'data:image/png;base64,iVBORw0K');
  assert.equal(vcardPhoto('https://x.example/p.jpg', 'VALUE=uri'), 'https://x.example/p.jpg');
  assert.equal(vcardPhoto('hello world', ''), undefined);
});
