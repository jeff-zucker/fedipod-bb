// render.test.mjs — a forum's page drawn on the server: what a stranger sees
// of the front page, a category and a topic, in the page as the site serves
// it, with what it was drawn from beside it for the browser.
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { forumUrls } from '../src/urls.mjs';
import * as fwire from '../src/wire.mjs';
import * as topics from '../src/topics.mjs';
import * as publish from '../src/publish.mjs';
import { renderPage } from '../src/render.mjs';
import { PodStore } from 'fedipod/core/store.mjs';
import { cacheKey } from '../site/read.mjs';

const POD = 'https://forum.example/';
const FRONT = 'https://fedipod.net/u/forum/';
const MEI = 'https://mei.pod.example/fedipod/ap/actor';
const SHELL = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');

function memStore() {
  const st = new PodStore({ log: () => {} });
  st.attach({ base: 'mem://', list: async () => ({ names: [], etag: null }), read: async () => ({ ok: false }),
    remove: async () => true, write: async () => ({ ok: true }) });
  return st;
}

// A forum the host wrote: two categories, one of them for its members only,
// a topic of two posts in the open one, and a post nobody may read in the other.
async function aForum() {
  const docs = new Map();
  const pod = { docs, putJson: async (u, o) => { docs.set(u, o); return { ok: true }; }, setAcl: async () => {} };
  const site = forumUrls(POD);
  const g = site.category('gardening');
  const s = site.category('seeds');
  const gStore = memStore();
  const siteStore = memStore();
  docs.set(site.actor, fwire.siteActorDoc({ urls: site, handle: 'forum', name: 'The Forum', publicKeyPem: 'x', summary: 'Growing things.' }));
  docs.set(g.actor, { id: g.actor, type: 'Group', preferredUsername: 'gardening', name: 'Gardening', summary: '<p>Soil.</p>' });
  docs.set(g.followers, { id: g.followers, type: 'OrderedCollection', totalItems: 3 });
  docs.set(s.actor, { id: s.actor, type: 'Group', preferredUsername: 'seeds', name: 'Seed swap', manuallyApprovesFollowers: true });
  await publish.publishCategories({ remote: pod, store: siteStore, urls: site }, [g.actor, s.actor]);
  const A = 'https://mei.pod.example/fedipod/ap/notes/blight';
  const R = 'https://mei.pod.example/fedipod/ap/notes/blight-r1';
  const ctx = { remote: pod, store: gStore, urls: g };
  const tid = topics.open(gStore, { title: 'Tomato blight', post: { id: A, author: MEI, published: '2026-09-15T10:00:00Z', inReplyTo: null } });
  topics.append(gStore, tid, { id: R, author: MEI, published: '2026-09-15T11:00:00Z', inReplyTo: A });
  await publish.cachePost(ctx, { id: A, type: 'Note', attributedTo: MEI, content: '<p>Three beds gone, and the fourth is going the same way.</p>',
    published: '2026-09-15T10:00:00Z', context: g.topic(tid), audience: g.actor });
  await publish.cachePost(ctx, { id: R, type: 'Note', attributedTo: MEI, content: '<p>Same here.</p>',
    published: '2026-09-15T11:00:00Z', inReplyTo: A, context: g.topic(tid), audience: g.actor });
  await publish.cacheAuthor(ctx, { id: MEI, type: 'Person', preferredUsername: 'mei', name: 'Mei' });
  await publish.publishTopic(ctx, tid);
  await publish.publishTopicIndex(ctx);
  // The members' post: its copy answers nobody who is not one of them.
  const P = 'https://mei.pod.example/fedipod/ap/private/seeds-1';
  const hidden = new Set([s.cached(P), s.home + 'ap/topics', s.followers]);
  siteStore.write('latest.json', [
    { copy: s.cached(P), at: '2026-09-15T12:00:00Z' },
    { copy: g.cached(R), at: '2026-09-15T11:00:00Z' },
    { copy: g.cached(A), at: '2026-09-15T10:00:00Z' },
  ]);
  docs.set(s.cached(P), { id: P, type: 'Note', content: '<p>Members only: the heirloom list.</p>', context: s.topic(tid), audience: s.actor });
  await publish.publishLatest({ remote: pod, store: siteStore, urls: site });
  // Read as a stranger reads it, through the Gateway's address for the forum.
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const at = url.startsWith(FRONT) ? POD + 'fedipod-bb/' + url.slice(FRONT.length) : url;
    if (hidden.has(at)) return new Response('', { status: 401 });
    const doc = docs.get(at);
    return doc ? new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/activity+json' } })
      : new Response('', { status: 404 });
  };
  return { docs, g, s, tid, A, R, P, fetch, asked };
}

const dataOf = (html) => JSON.parse(/<script type="application\/json" id="bb-data">([\s\S]*?)<\/script>/u.exec(html)[1]);
const mainOf = (html) => /<main id="main" tabindex="-1">([\s\S]*?)<\/main>/u.exec(html)[1];

test('a topic is drawn as a stranger sees it, named by its topic and its opening words', async () => {
  const f = await aForum();
  const out = await renderPage({ url: `https://bb.fedipod.net/forum/t/gardening/${f.tid}`, shell: SHELL, fetch: f.fetch });
  assert.equal(out.status, 200);
  assert.match(out.html, /<title>Tomato blight<\/title>/u);
  assert.match(out.html, /<meta name="description" content="Three beds gone, and the fourth is going the same way\.">/u);
  const main = mainOf(out.html);
  assert.match(main, /<h1>Tomato blight<\/h1>/u);
  assert.match(main, /Three beds gone/u);
  assert.match(main, /Same here\./u);
  assert.match(main, /Mei <span class="dim">@mei@mei\.pod\.example<\/span>/u, 'the author by name and handle');
  assert.match(main, new RegExp(`id="p-${await cacheKey(f.R)}"`, 'u'), 'each post carries the anchor a link names it by');
  assert.match(main, /class="nest"/u, 'the reply sits under what it answers');
  assert.match(main, /data-act="reply"/u, 'an open topic offers a reply');
  assert.doesNotMatch(main, /data-act="(edit|delete|remove|report|save)"/u, 'a stranger is offered nothing that needs an account');
  assert.match(out.html, /<a id="forum-link" href="\/forum\/">The Forum<\/a>/u);
  assert.match(out.html, /<nav class="crumbs" id="crumbs" aria-label="Breadcrumb"><a href="\/forum\/">Home<\/a> › <a href="\/forum\/c\/gardening">Gardening<\/a> › Tomato blight<\/nav>/u);
  assert.deepEqual(out.tags.sort(), ['u-forum', 'u-gardening', 'u-seeds']);
  const data = dataOf(out.html);
  assert.deepEqual(data.view, { kind: 'topic', slug: 'gardening', tid: f.tid });
  assert.equal(data.forum.name, 'The Forum');
  assert.equal(data.topic.posts.length, 2, 'what it was drawn from is in the page');
  assert.ok(f.asked.every(u => !u.includes('ap/private/')), 'nothing private is asked for');
});

test('the front page lists what a stranger may read, linked by the topic\'s own address', async () => {
  const f = await aForum();
  const out = await renderPage({ url: 'https://bb.fedipod.net/forum/', shell: SHELL, fetch: f.fetch });
  assert.equal(out.status, 200);
  assert.match(out.html, /<title>The Forum<\/title>/u);
  assert.match(out.html, /<meta name="description" content="Growing things\.">/u);
  const main = mainOf(out.html);
  assert.match(main, new RegExp(`<a href="/forum/t/gardening/${f.tid}#p-${await cacheKey(f.R)}">Tomato blight</a>`, 'u'));
  assert.match(main, /<a class="chip on" aria-current="page" href="\/forum\/">All<\/a>/u);
  assert.match(main, /<a class="chip" href="\/forum\/c\/seeds">Seed swap<\/a>/u);
  assert.doesNotMatch(out.html, /heirloom/u, 'a members-only post is on no drawn page, nor in what rides with it');
  // Pinned across the forum and pinned in a category: two different pins.
  const site = 'https://forum.example/fedipod-bb/ap/featured';
  const garden = f.g.featured;
  f.docs.set(site, { id: site, type: 'OrderedCollection', orderedItems: [f.g.topic(f.tid)] });
  const both = mainOf((await renderPage({ url: 'https://bb.fedipod.net/forum/', shell: SHELL, fetch: f.fetch })).html);
  assert.match(both, /aria-label="pinned across the forum">📌<\/span>/u, 'a pushpin across the forum');
  f.docs.set(site, { id: site, type: 'OrderedCollection', orderedItems: [] });
  f.docs.set(garden, { id: garden, type: 'OrderedCollection', orderedItems: [f.g.topic(f.tid)] });
  const cat = mainOf((await renderPage({ url: 'https://bb.fedipod.net/forum/', shell: SHELL, fetch: f.fetch })).html);
  assert.match(cat, /aria-label="pinned in this category">📍<\/span>/u, 'a round pin within its category');
  assert.doesNotMatch(cat, /⭐/u);
  assert.match(out.html, /<span id="mods-acts">[\s\S]*data-act="newtopic"/u);
  assert.match(out.html, /<nav class="crumbs" id="crumbs" aria-label="Breadcrumb" hidden><\/nav>/u, 'the front page has no trail');
  const data = dataOf(out.html);
  assert.equal(data.index.latest.length, 2);
  assert.equal(data.index.limit, 150);
});

test('a members-only category says so, and shows nothing of what is in it', async () => {
  const f = await aForum();
  const out = await renderPage({ url: 'https://bb.fedipod.net/forum/c/seeds', shell: SHELL, fetch: f.fetch });
  assert.equal(out.status, 200);
  assert.match(out.html, /<title>Seed swap<\/title>/u);
  assert.match(mainOf(out.html), /This category is for its members, and membership needs a FediPod account\./u);
  assert.match(mainOf(out.html), /href="https:\/\/fedipod\.net\/new-account"/u);
  assert.doesNotMatch(out.html, /heirloom/u);
});

test('a post is drawn with only the markup a post may carry', async () => {
  const f = await aForum();
  f.docs.set(f.g.cached(f.R), { ...f.docs.get(f.g.cached(f.R)),
    content: '<p>Same <strong>here</strong></p><img src="https://tracker.example/x.png"><script>alert(1)</script>'
      + '<a href="javascript:alert(1)">x</a><span onclick="alert(1)">y</span><a href="https://forum.example/fedipod-bb/c/gardening/ap/actor">@gardening</a>' });
  const out = await renderPage({ url: `https://bb.fedipod.net/forum/t/gardening/${f.tid}`, shell: SHELL, fetch: f.fetch });
  const main = mainOf(out.html);
  assert.match(main, /<p>Same <strong>here<\/strong><\/p>/u);
  assert.doesNotMatch(main, /<img|<script|javascript:|onclick/u);
  assert.doesNotMatch(main, />@gardening</u, 'the link naming the category every reader is in is left out');
});

test('a closed topic offers no reply', async () => {
  const f = await aForum();
  const head = f.g.topic(f.tid);
  f.docs.set(head, { ...f.docs.get(head), closed: '2026-09-16T00:00:00Z' });
  const main = mainOf((await renderPage({ url: `https://bb.fedipod.net/forum/t/gardening/${f.tid}`, shell: SHELL, fetch: f.fetch })).html);
  assert.match(main, /This topic is closed\. No more replies are being taken\./u);
  assert.doesNotMatch(main, /data-act="(reply|newpost)"/u);
});

test('a topic or a category that is not there is drawn as not found', async () => {
  const f = await aForum();
  const topic = await renderPage({ url: 'https://bb.fedipod.net/forum/t/gardening/nothing', shell: SHELL, fetch: f.fetch });
  assert.equal(topic.status, 404);
  assert.match(mainOf(topic.html), /No such topic\./u);
  const cat = await renderPage({ url: 'https://bb.fedipod.net/forum/t/weeds/x', shell: SHELL, fetch: f.fetch });
  assert.equal(cat.status, 404);
  assert.match(mainOf(cat.html), /No such category\./u);
  assert.equal((await renderPage({ url: 'https://bb.fedipod.net/forum/c/weeds', shell: SHELL, fetch: f.fetch })).status, 404);
});

test('what cannot be drawn whole is not drawn at all', async () => {
  const f = await aForum();
  const url = `https://bb.fedipod.net/forum/t/gardening/${f.tid}`;
  assert.equal(await renderPage({ url, shell: SHELL, fetch: async () => { throw new Error('down'); } }), null, 'a pod that does not answer');
  assert.equal(await renderPage({ url, shell: SHELL, fetch: async () => new Response('', { status: 503 }) }), null);
  const slow = async (u) => { await new Promise(r => setTimeout(r, 200)); return f.fetch(u); };
  const started = Date.now();
  assert.equal(await renderPage({ url, shell: SHELL, fetch: slow, deadlineMs: 300 }), null, 'past its time');
  assert.ok(Date.now() - started < 1000, 'and it does not wait for the reads to finish');
  // Past its time, the drawing is handed to the host to finish after the
  // page has gone, and it does finish: its reads are what the next reader's
  // drawing finds at hand.
  let kept = null;
  f.asked.length = 0;
  assert.equal(await renderPage({ url, shell: SHELL, fetch: slow, deadlineMs: 300, keepGoing: (p) => { kept = p; } }), null);
  assert.ok(kept, 'the unfinished drawing is handed over');
  const finished = await kept;
  assert.equal(finished?.status, 200, 'and it finishes');
  assert.ok(f.asked.some(u => u.includes(`/ap/topic/${f.tid}`)), 'having read the topic');
  assert.equal(await renderPage({ url, shell: SHELL, fetch: slow, deadlineMs: 300, keepGoing: () => { throw new Error('no'); } }), null,
    'a host that will not wait still gets the page undrawn');
  assert.equal(await renderPage({ url: url + '?code=x&state=y', shell: SHELL, fetch: f.fetch }), null, 'an address with a query, as a sign-in comes back to');
  assert.equal(await renderPage({ url: `https://fedipod.net/forum/t/gardening/${f.tid}`, shell: SHELL, fetch: f.fetch }), null, 'only at the forum\'s own host');
  assert.equal(await renderPage({ url, shell: '<html>nothing to fill</html>', fetch: f.fetch }), null, 'a page without its parts');
});

test('what rides in the page cannot end the element it rides in', async () => {
  const f = await aForum();
  const head = f.g.topic(f.tid);
  f.docs.set(head, { ...f.docs.get(head), name: 'Blight </script><script>alert(1)</script>' });
  const out = await renderPage({ url: `https://bb.fedipod.net/forum/t/gardening/${f.tid}`, shell: SHELL, fetch: f.fetch });
  const data = /<script type="application\/json" id="bb-data">([\s\S]*?)<\/script>/u.exec(out.html)[1];
  assert.doesNotMatch(data, /<\//u);
  assert.equal(JSON.parse(data).topic.t.name, 'Blight </script><script>alert(1)</script>');
  assert.match(out.html, /<title>Blight &lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/u);
});
