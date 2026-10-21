// resend.test.mjs — a post of the reader's own the forum never took in: the
// page offers to send it again, and sending it again hands the forum the same
// post in the same Create, read back from the author's own pod.
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { card, NOBODY, addresses } from '../site/draw.mjs';
import { resend, podUrlOf } from '../site/pod.mjs';

const d = { viewer: NOBODY, addr: addresses('/forum/'), handleOf: () => '@fedipod@fedipod.net', parse: null };
const parse = (html) => ({ childNodes: [{ nodeType: 3, nodeValue: html.replace(/<[^>]*>/gu, '') }] });
const POST = 'https://fedipod.net/u/jeff/ap/notes/2026-09-29-post-0c5b7a69';

test('a waiting post of one\'s own offers to be sent again, and nothing else', () => {
  const withIt = card({ id: POST, author: '@jeff@fedipod.net', published: '2026-09-29T00:21:03Z', content: 'Test', resend: true },
    { extra: ' waiting', waiting: true }, { ...d, parse });
  assert.match(withIt, new RegExp(`data-post="${POST}"`, 'u'));
  assert.match(withIt, /<button data-act="resend" aria-label="Send your post to the forum again">Send again<\/button>/u);
  assert.doesNotMatch(withIt, /data-act="(reply|share|vote-up)"/u, 'a post the forum does not have offers nothing else');
  const without = card({ id: POST, author: '@jeff@fedipod.net', published: new Date().toISOString(), content: 'Test' },
    { extra: ' waiting', waiting: true }, { ...d, parse });
  assert.doesNotMatch(without, /data-act=/u, 'a waiting post the page has not marked for sending again offers nothing');
});

test('sending again hands the forum the same post, read back from the pod, in the same Create', async () => {
  const actor = 'https://fedipod.net/u/jeff/ap/actor';
  const podHome = 'https://fp1.solidcommunity.net/fedipod/';
  const note = { id: POST, type: 'Note', attributedTo: actor, content: '<p>Test of a reply to a reply</p>',
    published: '2026-09-29T00:21:03.938Z', to: ['https://www.w3.org/ns/activitystreams#Public', 'https://fedipod.net/u/fedipod/ap/actor'] };
  assert.equal(podUrlOf(actor, podHome, POST), 'https://fp1.solidcommunity.net/fedipod/ap/notes/2026-09-29-post-0c5b7a69');
  const read = [];
  const session = { fetch: async (u) => { read.push(u); return new Response(JSON.stringify(note), { status: 200 }); } };
  const posted = [];
  const fetch = async (u, init) => { posted.push([u, JSON.parse(init.body)]); return new Response('', { status: 202 }); };
  await resend({ actor, podHome, id: POST, inbox: 'https://fedipod.net/u/fedipod/ap/inbox/', session, fetch });
  assert.deepEqual(read, ['https://fp1.solidcommunity.net/fedipod/ap/notes/2026-09-29-post-0c5b7a69'], 'read where it is written');
  assert.equal(posted.length, 1);
  const [to, create] = posted[0];
  assert.equal(to, 'https://fedipod.net/u/fedipod/ap/inbox/');
  assert.equal(create.id, `${POST}#create`, 'the same Create as the first time');
  assert.equal(create.type, 'Create');
  assert.equal(create.actor, actor);
  assert.deepEqual(create.object, note, 'with the post as it is');
  assert.deepEqual(create.to, note.to);
  await assert.rejects(resend({ actor, podHome, id: POST, inbox: 'https://x.example/', session,
    fetch: async () => new Response('', { status: 503 }) }), /did not take it \(HTTP 503\)/u);
  await assert.rejects(resend({ actor, podHome, id: POST, inbox: 'https://x.example/', fetch,
    session: { fetch: async () => new Response('', { status: 404 }) } }), /could not give the post back \(HTTP 404\)/u);
});
