// sent-listing.test.mjs — a reply just sent from the page is looked for in
// what the forum lists, for half a minute, until it is there.
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { sentNotListed } from '../site/read.mjs';

const id = 'https://mastodon.example/users/putri/statuses/9001';
const at = 1_000_000;
const sent = { id, until: at + 30_000 };

test('a reply the forum does not list yet is still waited for', () => {
  assert.equal(sentNotListed(sent, [{ id: 'https://mastodon.example/users/putri/statuses/1' }], at + 5_000), true);
  assert.equal(sentNotListed(sent, [], at), true);
});

test('waiting stops once the forum lists it, or after half a minute', () => {
  assert.equal(sentNotListed(sent, [{ id }], at + 5_000), false);
  assert.equal(sentNotListed(sent, [], at + 30_000), false);
});

test('nothing sent is nothing to wait for', () => {
  assert.equal(sentNotListed(null, [], at), false);
  assert.equal(sentNotListed({ id: null, until: at + 30_000 }, [], at), false);
});
