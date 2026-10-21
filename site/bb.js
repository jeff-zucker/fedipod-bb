// bb.js — the forum website: reads a forum from its pod (through this site's
// own /u/<handle>/ when the forum is attached here, or a pod named outright)
// and shows categories, topics and threads. Replying signs the reader in
// with a Mastodon account and posts from it; the reply appears here once the
// forum's host has placed it, and until then the reader sees their own copy
// marked as waiting.
//
//   /bb/?forum=<handle>            a forum attached to this site
//   /bb/?pod=https://…/fedipod-bb/  a forum read from its pod directly
//   https://bb.<site>/<handle>/     the same forum at its own address, where
//     <handle>/c/<slug> and <handle>/t/<slug>/<tid> are a category and a topic
//   #/  #/c/<slug>  #/t/<slug>/<tid>   the same views anywhere else
//
// At its own host a forum's page may arrive drawn, with what it was drawn
// from beside it (src/render.mjs); the page then reads none of that again.

import { reader, placeOf, viewOfPath, authorLabel, cacheKey, categoryBase, cleanHtml, sentNotListed } from './read.mjs';
import { MastoLogin, hostOfHandle, serverKind, actorOfHandle, returnAddress } from './masto.mjs';
import * as pod from './pod.mjs';
import { mine as keptByReader } from './mine.mjs';
import { readState } from './seen.mjs';
import { toHtml } from './markdown.mjs';
import * as draw from './draw.mjs';

const { esc, when } = draw;
const $ = (id) => document.getElementById(id);
// Said to a screen reader when the page changes under it and no focus moves:
// what is loading, how much arrived, that a link was copied.
const say = (msg) => { const el = $('say'); if (el) el.textContent = msg; };
const ago = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 2) return 'just now';
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

const params = new URLSearchParams(location.search);
const place = placeOf({ origin: location.origin, pathname: location.pathname, search: location.search });
const { front, base } = place;
const frontHost = new URL(front).host;
const addr = draw.addresses(place.root);
// Where a sign-in comes back to: the forum's own address at its own host,
// whichever of its pages it started from, so a reader's server is asked to
// approve one address and not one per topic. Where the reader was is kept
// beside it (`bb:return`) and gone back to after.
const signInAddress = place.root ? location.origin + place.root : location.origin + location.pathname;
const whereNow = () => (place.root ? location.pathname + location.hash : location.hash);
// What the page arrived drawn from, when it was drawn at the forum's host.
const boot = (() => { try { return JSON.parse($('bb-data')?.textContent || 'null'); } catch { return null; } })();
// The reader asks anonymously first; where a category is members-only it
// asks again with the pod session, if there is one. Right after this reader
// posts, the next read goes past the browser's own copy of each document (a
// front lets a browser keep one for a minute): a post the forum placed as it
// arrived is then on the page at once, not a minute later.
let freshRead = false;
const readerFetch = (url, init = {}) => fetch(url, freshRead ? { ...init, cache: 'reload' } : init);
const makeReader = (session = null) => reader({ session, fetch: readerFetch });
let read = makeReader();
const login = new MastoLogin({ storage: localStorage,
  redirectUri: returnAddress(place.root ? signInAddress + location.search : location.href) });
// What this reader has already read. Theirs, in their own browser: a public
// forum has nowhere to keep it and no business keeping it.
const seen = base ? readState({ storage: localStorage, forum: base }) : null;

let forum = null;
let podAcct = null;          // { handle, actor, webId } when signed in with a pod
let moderators = [];         // the category's own list, read from the forum
const account = () => podAcct || login.account();
const cats = () => forum?.categories || [];
const iModerate = () => {
  const me = podAcct?.actor || login.account()?.url;
  return !!me && moderators.includes(me);
};
const catBySlug = (slug) => cats().find(c => c.slug === slug || c.base.endsWith('/c/' + slug + '/'));
const handleOf = (cat) => {
  // Through a Gateway a category answers as @slug@gateway; read from a pod, its id is its address.
  if (place.handle && cat.slug) return `@${cat.slug}@${frontHost}`;
  return cat.id;
};
// Whose post this is, as this browser can tell: a pod account is its actor,
// a Mastodon account is the profile its server gave us.
const mine = (p) => {
  const me = podAcct?.actor || login.account()?.url;
  return !!me && !!p?.author && (p.author === me || p.author === podAcct?.webId);
};

// Who is reading, as the drawing (draw.mjs) needs to know it.
function viewer() {
  const isNew = (topic, at) => !!seen?.isNew(topic, at);
  if (!account()) return { ...draw.NOBODY, isNew };
  return { account: true, pod: !!podAcct, moderates: iModerate(), isNew, mine,
    votedOn: (id) => own().votedOn(id), isSaved: (id) => own().isSaved(id), isJoined: (id) => own().isJoined(id) };
}
const drawing = () => ({ viewer: viewer(), addr, handleOf });
const body = (p, cat) => draw.body(p, cat, drawing());
const card = (p, opts = {}) => draw.card(p, opts, drawing());

// The page as it arrived drawn is left as it is, unless this reader would be
// shown something a stranger is not.
const asDrawn = (drawn) => !!drawn && !account() && !iModerate();

const waitingKey = (topicId) => 'bb:waiting:' + topicId;
const waiting = (topicId) => { try { return (JSON.parse(localStorage.getItem(waitingKey(topicId)) || '[]') || []).filter(w => w?.id); } catch { return []; } };
// A copy is kept only for a post that is waiting to be PLACED, and only when
// it carries the id the topic will name it by: an entry nothing can match is
// an entry nothing can ever clear.
const remember = (topicId, entry) => {
  if (!entry?.id) return;
  try { localStorage.setItem(waitingKey(topicId), JSON.stringify([...waiting(topicId), entry].slice(-20))); } catch { /* full or blocked */ }
};

async function load() {
  if (!base) {
    $('main').innerHTML = `<p class="err">Name a forum: <code>${esc(location.origin)}/&lt;forum&gt;/</code></p>`;
    return;
  }
  forum = boot?.forum || await read.forum(base);
  if (!forum) {
    // A forum that does not exist and one whose pod is down read the same
    // to the reader above; asking once more tells them apart, so a reader is
    // never told a forum is gone when its server is only unreachable.
    const r = await fetch(base + 'ap/actor', { headers: { accept: 'application/activity+json' } }).catch(() => null);
    const missing = r && (r.status === 404 || r.status === 410);
    $('main').innerHTML = missing
      ? '<p class="err">No forum answers at this address.</p>'
      : '<p class="err">The pod that holds this forum is not answering right now, so the forum cannot be shown. Try again later.</p>';
    return;
  }
  $('forum-link').textContent = forum.name || 'Forum';
  $('forum-link').setAttribute('href', addr.front());
  // Who moderates, under the line: the forum's own list, each name linking to
  // the page that account keeps.
  if (!boot) $('mods-who').innerHTML = draw.modsWho((forum.admins || []).map(a => ({ id: a.id, handle: a.handle })));
  takeDrawn();
  route();
}

function crumbs(parts) {
  const trail = draw.crumbs(parts);
  $('crumbs').hidden = trail.hidden;
  $('crumbs').innerHTML = trail.html;
}

// The drawn page is the first view's only. After it, every view is the
// page's own to read and draw.
let first = true;
const drawnFor = (kind, slug = null, tid = null) => {
  if (!first || !boot?.view || boot.view.kind !== kind) return null;
  if ((slug && boot.view.slug !== slug) || (tid && boot.view.tid !== tid)) return null;
  // A reader signed in to a pod may read what a stranger may not, so a forum
  // with a members-only category is read again as them.
  if (podAcct && cats().some(c => c.private)) return null;
  return boot;
};

// Who the page is holding, in the top row: the handle a reader posts under,
// and the way in when there is nobody. Signing in from here is what makes the
// moderator's Queue and Settings reachable at all.
function paintWho() {
  const acct = account();
  $('who-name').textContent = acct ? `signed in as ${acct.handle}` : '';
  $('who-act').textContent = acct ? 'Sign out' : 'Sign in';
}

// Which view an address names, leaving out the post a link points at.
const viewKey = () => location.pathname + (location.hash.startsWith('#/') ? location.hash : '');
let routed = null;

async function route() {
  routed = viewKey();
  paintWho();
  // Searching and starting a topic belong to the forum's own view; the rest of
  // the page keeps the moderators line and nothing else.
  const hash = location.hash.startsWith('#/') ? location.hash.slice(2) : '';
  const [kind, a, b, c] = hash.split('/');
  // At the forum's own host the front page, a category and a topic have
  // addresses of their own, and an old link to one of them is taken there.
  if (place.root && location.hash.startsWith('#/') && !HASH_VIEWS.has(kind)) {
    const to = kind === 'c' && a ? addr.cat(a) : kind === 't' && a && b ? addr.topic(a, b, c || null) : addr.front();
    if (to.split('#')[0] !== location.pathname) { location.replace(to); return undefined; }
    history.replaceState(null, '', to);
    return route();
  }
  if (!first || !boot) $('mods-acts').innerHTML = '';
  const mine = ++view;
  void mine;
  $('reply-row').hidden = true;
  $('reply-dlg').close();
  if (kind === 'replies') return showReplies();
  if (kind === 'bookmarks' || kind === 'saved') return showSaved();
  if (kind === 'queue') return showQueue();
  if (kind === 'settings') return showSettings();
  if (kind === 'who' && a) return showWho(decodeURIComponent(a));
  const at = place.root ? viewOfPath(location.pathname, place.root)
    : kind === 'c' && a ? { kind: 'cat', slug: a } : kind === 't' && a && b ? { kind: 'topic', slug: a, tid: b, post: c || null } : { kind: 'front' };
  if (at.kind === 'cat') { if (feedFilter !== at.slug) shown = 30; feedFilter = at.slug; return showForum(); }
  if (at.kind === 'topic') return showTopic(at.slug, at.tid, at.post || (/^#p-([0-9a-f]+)$/u.exec(location.hash)?.[1] ?? null));
  // `#/` IS the whole forum, so arriving at it clears the category. Leaving the
  // filter where it was meant Home redrew whatever category you had been in,
  // and All — whose link is `#/` — redrew the same one, which from the reader's
  // side was a button that did nothing at all.
  if (feedFilter !== 'all') { feedFilter = 'all'; shown = 30; }
  return showForum();
}

// The front page is an index of what has been said, newest first, across the
// forum: which category, which topic, who, and when. The words themselves are
// in the topic, one click away.
let feedFilter = 'all';        // 'all', or a category's slug
let shown = 30;                // how many of the index's rows are on the page
let view = 0;                  // which view the page is on; an older one must not draw
let order = 'date';            // which column the index is ordered by
let down = true;               // and which way
let finding = '';              // what the reader is looking for, if anything
// The views that are this reader's own, or a moderator's: after `#` everywhere.
const HASH_VIEWS = new Set(['replies', 'bookmarks', 'saved', 'queue', 'settings', 'who']);
// What this reader keeps for themselves, under the account they signed in as.
const own = () => keptByReader({ storage: localStorage, who: account()?.handle || null });

// Answers to this reader's own posts, newest first. The forum publishes what
// each post answers, so nobody has to be told whom to notify.
async function showReplies() {
  crumbs([['Home', addr.front()], ['Replies to you', null]]);
  const me = podAcct?.actor || login.account()?.url;
  if (!me) { $('main').innerHTML = '<p class="empty">Sign in to see answers to your posts.</p>'; return; }
  $('main').innerHTML = '<p class="dim">Looking…</p>';
  const latest = await read.latest(base, { limit: 200 });
  const mineIds = new Set(latest.filter(p => p.author === me).map(p => p.id));
  const answers = latest.filter(p => p.inReplyTo && mineIds.has(p.inReplyTo) && p.author !== me);
  if (!answers.length) { $('main').innerHTML = '<p class="empty">Nobody has answered you yet.</p>'; return; }
  const items = [];
  for (const p of answers) {
    const cat = cats().find(c => c.id === p.category) || null;
    const who = cat && p.author ? await read.author(cat.base, p.author) : null;
    const tid = p.topic ? p.topic.split('/').pop() : null;
    const href = esc(cat && tid ? addr.topic(cat.slug, tid, await cacheKey(p.id)) : addr.front());
    items.push(`<li><a class="title" href="${href}">${esc(p.topicName || 'Topic')}</a>
      <div class="meta">${who ? esc(who.handle) : esc(authorLabel(p.author || ''))} · ${esc(when(p.published))}</div>
      <article class="post"><div class="body">${cleanHtml(p.content)}</div></article></li>`);
  }
  $('main').innerHTML = `<ul class="list">${items.join('')}</ul>`;
}

// Posts this reader kept. The list is theirs and lives in this browser.
function showSaved() {
  crumbs([['Home', addr.front()], ['Bookmarked', null]]);
  const rows = own().saved();
  if (!rows.length) { $('main').innerHTML = '<p class="empty">Nothing bookmarked yet. Use Bookmark on a post.</p>'; return; }
  $('main').innerHTML = `<ul class="list">${rows.map(r => {
    const cat = cats().find(c => c.slug === r.cat) || null;
    const tid = r.topic ? r.topic.split('/').pop() : null;
    const href = esc(cat && tid ? addr.topic(cat.slug, tid) : addr.front());
    return `<li><a class="title" href="${href}">${esc(r.text || r.id)}</a>
      <div class="meta">bookmarked ${esc(when(r.at))}${cat ? ' · ' + esc(cat.name) : ''}</div></li>`;
  }).join('')}</ul>`;
}

// The moderators' queue: reports, posts held from people who have not joined,
// and asks not yet acted on. Read from the forum's pod with the moderator's
// own login — it is not public and never passes through the Gateway.
async function showQueue() {
  crumbs([['Home', addr.front()], ['Queue', null]]);
  if (!podAcct) { $('main').innerHTML = '<p class="empty">The queue is read with your pod account.</p>'; return; }
  $('main').innerHTML = '<p class="dim">Reading the queue…</p>';
  try {
    const said = await serverKind(new URL(front).host, front, undefined, forum.handle || 'forum');
    if (!said?.podHome) throw new Error('this forum does not say where its pod is');
    const q = await pod.modQueue(said.podHome);
    // Only what a moderator can act on: a report, a held post, a join
    // request, and an ask that did not take. Another moderator's ask on its
    // way through is the forum's business, not a row with no button.
    const ACTS = new Set(['Flag', 'Held', 'Create', 'Join request']);
    const rows = (q?.rows || []).filter(r => r.failed || ACTS.has(r.type));
    if (!rows.length) { $('main').innerHTML = '<p class="empty">Nothing is waiting.</p>'; return; }
    $('main').innerHTML = `<ul class="list">${rows.map(r => `<li>
      <div class="title">${esc(r.type)}${r.category ? ' · ' + esc(r.category) : ''}</div>
      <div class="meta">${r.type === 'Flag' ? 'reported by ' : ''}${esc(r.by ? authorLabel(r.by) : '')}${r.about ? ` · about <a href="#/who/${encodeURIComponent(r.about)}">${esc(authorLabel(r.about))}</a>` : ''} · ${esc(when(r.at))}${r.verified ? ' · checked' : ''}</div>
      ${r.object ? `<div class="dim">${esc(r.object)}</div>` : ''}
      ${r.failed ? `<p class="err">It did not take: ${esc(r.failed)}${r.failedAt ? ` (${esc(when(r.failedAt))})` : ''}. It is still here and will be tried again.</p>` : ''}
      ${r.why ? `<article class="post"><div class="body">${esc(r.why)}</div></article>` : ''}
      ${r.object ? `<div class="acts mod" data-post="${esc(r.object)}" data-cat="${esc(r.category || '')}">
        ${r.type === 'Held' || r.type === 'Create' ? '<button data-act="approve">Let it through</button><button data-act="refuse">Turn it away</button>' : ''}
        ${r.type === 'Join request' ? '<button data-act="admit">Admit</button><button data-act="refuse">Turn them away</button>' : ''}
        ${r.about ? '<button data-act="ban" data-who="' + esc(r.about) + '">Ban the author</button>' : ''}
        ${r.about && r.object ? '<button data-act="removepost" data-post="' + esc(r.object) + '">Remove the post</button>' : ''}
        ${r.type !== 'Flag' && r.by ? '<button data-act="ban" data-who="' + esc(r.by) + '">Ban them</button>' : ''}
      </div>` : ''}
    </li>`).join('')}</ul>`;
  } catch (e) { $('main').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

async function showWho(handleOrId) {
  crumbs([['Home', addr.front()], ['Someone', null]]);
  $('main').innerHTML = '<p class="dim">Looking…</p>';
  const latest = await read.latest(base, { limit: 200 });
  const theirs = latest.filter(p => p.author === handleOrId);
  const cat = theirs[0] ? cats().find(c => c.id === theirs[0].category) : cats()[0];
  // What the forum kept of them, and failing that their own actor: a moderator
  // who has never posted here has no card, and this page is where every handle
  // in the forum now leads.
  const kept = cat ? await read.author(cat.base, handleOrId) : null;
  // The copy the forum kept may predate the account saying where its profile
  // is, so where it names no page the account itself is asked.
  const said = kept?.url ? null : await read.actorCard(handleOrId).catch(() => null);
  const card = kept && said ? { ...kept, url: said.url, name: kept.name || said.name } : (kept || said);
  crumbs([['Home', addr.front()], [card?.handle || authorLabel(handleOrId), null]]);
  const named = esc(card?.handle || authorLabel(handleOrId));
  // A word with them and nobody else. Only from a pod account: the message is
  // written on the sender's own pod before it is handed over.
  const messageBox = podAcct && podAcct.actor !== handleOrId ? `<section class="reply">
    <h2>Post to ${named}'s timeline</h2>
    <p class="hint">A post of yours that names them, so it reaches them and anyone who reads either of
      you. It is public: everybody can read it. Your own account posts it and signs it, so it reaches
      Mastodon and the rest of the Fediverse — which means it goes out when your agent next reads its
      inbox, and that it needs an account fronted at this Gateway.</p>
    <label class="vh" for="dm-text">Your post</label>
    <textarea id="dm-text" rows="3" placeholder="Your post"></textarea>
    <p class="row"><button class="primary" data-act="post-to" data-to="${esc(handleOrId)}"
      data-handle="${esc(card?.handle || '')}">Post</button></p>
    <p class="err" id="dm-err" role="alert"></p>
  </section>` : '';
  const head = `<div class="topline"><h1>${esc(card?.name || card?.handle || authorLabel(handleOrId))}</h1></div>
    <p class="hint">${named}${card?.url ? ` · <a href="${esc(card.url)}">their profile</a>` : ''}
      · ${theirs.length} post${theirs.length === 1 ? '' : 's'} here</p>${messageBox}`;
  if (!theirs.length) { $('main').innerHTML = head + '<p class="empty">Nothing from them in what the forum is holding.</p>'; return; }
  const items = [];
  for (const p of theirs) {
    const c = cats().find(x => x.id === p.category) || null;
    const tid = p.topic ? p.topic.split('/').pop() : null;
    const href = esc(c && tid ? addr.topic(c.slug, tid, await cacheKey(p.id)) : addr.front());
    items.push(`<li><a class="title" href="${href}">${esc(p.topicName || 'Topic')}</a>
      <div class="meta">${c ? esc(c.name) + ' · ' : ''}${esc(when(p.published))} · ▲ ${p.likes || 0} ▼ ${p.dislikes || 0}</div>
      <article class="post"><div class="body">${cleanHtml(p.content)}</div></article></li>`);
  }
  $('main').innerHTML = head + `<ul class="list">${items.join('')}</ul>`;
}

// What a moderator may change about the forum itself. Every change is a
// request published at the moderator's own pod and checked there, so this
// page needs no rights on the forum's pod at all.
// Who moderates is learned while the forum is drawn. A page opened straight
// at a link — Settings, say, or a bookmark — has drawn nothing yet, and would
// take a moderator for a stranger and turn them away.
async function knowModerators() {
  if (moderators.length || !cats().length) return;
  const lists = await Promise.all(cats().map(c => read.moderators(c.base).catch(() => [])));
  moderators = [...new Set(lists.flat())];
}

async function showSettings() {
  crumbs([['Home', addr.front()], ['Settings', null]]);
  await knowModerators();
  if (!iModerate()) { $('main').innerHTML = '<p class="empty">Only this forum\'s moderators may change it.</p>'; return; }
  if (!podAcct) { $('main').innerHTML = '<p class="empty">Changing the forum is done with your pod account.</p>'; return; }
  $('main').innerHTML = `
    <div class="topline"><h1>Settings</h1></div>
    <section class="reply">
      <h2>The forum</h2>
      <div class="row oneline">
        <label for="set-forum-name">Name</label>
        <input type="text" id="set-forum-name" value="${esc(forum.name || '')}">
        <button data-act="set-forum-name">Rename</button>
        <button data-act="open-mods">Manage moderators</button>
      </div>
    </section>
    <section class="reply">
      <h2>Categories</h2>
      <ul class="list bare">${cats().map(c => `<li>
        <div class="row">
          <input type="text" class="cat-name" data-cat="${esc(c.id)}" value="${esc(c.name)}">
          <button data-act="set-cat-name" data-cat="${esc(c.id)}">Rename</button>
          <button data-act="open-members" data-cat="${esc(c.id)}">Manage members</button>
          <span class="dim">${esc(handleOf(c))}</span>
          <label><input type="radio" name="cat-private-${esc(c.slug || c.id)}" data-act="set-cat-private" data-cat="${esc(c.id)}" value="open"${c.private ? '' : ' checked'}> Open</label>
          <label><input type="radio" name="cat-private-${esc(c.slug || c.id)}" data-act="set-cat-private" data-cat="${esc(c.id)}" value="private"${c.private ? ' checked' : ''}> Private</label>
        </div>
      </li>`).join('')}</ul>
    </section>
    <section class="reply">
      <h2>New Category</h2>
      <div class="row oneline">
        <label for="set-new-name">Category name</label>
        <input type="text" id="set-new-name">
        <label for="set-new-slug">Category slug</label>
        <input type="text" id="set-new-slug" placeholder="Fediverse Username" size="18">
      </div>
      <div class="row">
        <label><input type="radio" name="set-new-private" value="open" checked> Open</label>
        <label><input type="radio" name="set-new-private" value="private"> Private</label>
        <button data-act="add-cat">Create</button>
      </div>
    </section>
`;
}

// The index, read once and filtered here. Changing category, ordering it,
// or typing in the search box changes NOTHING about what the forum holds — yet
// each of them refetched every post, every category's moderators and every
// category's pinned topics, and blanked the page to "Loading…" while it went.
// Searching did it on every keystroke.
//
// So it is read once and kept: whole, unfiltered, for every category, because
// which subset is on screen is the reader's business and not the network's.
// Thrown away after a minute, when more rows are asked for than were fetched,
// and by hand whenever this page writes something the forum will show back.
let index = null;
const INDEX_STALE_MS = 60_000;
function forgetIndex() { index = null; authors.clear(); }
// A post just sent from here is listed once its server has delivered it to
// the forum. Until then the index is read again every few seconds, for half a
// minute, instead of being kept for a minute without it.
const SENT_EVERY_MS = 5_000;
const SENT_WAIT_MS = 30_000;
// How long a post of this reader's may wait for the forum before the page
// offers to send it again.
const RESEND_AFTER_MS = 3_600_000;
let sent = null;               // { id, until }
const waitingOnSent = (idx) => sentNotListed(sent, idx?.latest);
const indexHolds = (idx, want) => !!idx && idx.limit >= want
  && Date.now() - idx.at < (waitingOnSent(idx) ? SENT_EVERY_MS : INDEX_STALE_MS);

// Who wrote it, and the digest a topic link carries. Both are asked once per
// ROW, and the same people and the same posts come round again every time the
// index is redrawn — so each was a fresh lookup for an answer that cannot have
// changed. Serially, too: thirty rows was thirty round trips one after another,
// which is where the wait after choosing a category actually went.
const authors = new Map();
const digests = new Map();
function authorOnce(catBase, id) {
  const key = `${catBase}|${id}`;
  if (!authors.has(key)) authors.set(key, read.author(catBase, id).catch(() => null));
  return authors.get(key);
}
function digestOnce(id) {
  if (!digests.has(id)) digests.set(id, cacheKey(id));
  return digests.get(id);
}

async function readIndex(want) {
  if (indexHolds(index, want)) return index;
  index = await draw.readIndex(read, base, cats(), want);
  return index;
}

// The drawn page's index, authors and digests, as if this page had read them.
function takeDrawn() {
  if (!boot || (podAcct && cats().some(c => c.private))) return;
  if (boot.index) index = { ...boot.index, at: Date.now() };
  for (const [key, card] of Object.entries(boot.facts?.authors || {})) authors.set(key, Promise.resolve(card));
  for (const [id, digest] of Object.entries(boot.facts?.digests || {})) digests.set(id, Promise.resolve(digest));
}

async function showForum() {
  const mineView = view;
  const here = cats().find(c => c.slug === feedFilter) || null;
  // As it arrived, when it arrived drawn for a stranger and this reader is one.
  const keep = first && asDrawn(drawnFor(here ? 'cat' : 'front', here?.slug || null)) && !finding;
  first = false;
  const trail = here ? [['Home', addr.front()], [here.name, addr.cat(here.slug)]] : [['Home', addr.front()]];
  if (!keep) crumbs(trail);
  // Enough posts to fill a page of TOPICS: several posts can belong to one.
  const want = Math.min(300, shown * 5);
  // Only say "Loading" when something is actually going to be waited for. The
  // reader changing category has everything already; blanking the page for
  // them was the whole of the delay they could see.
  if (!indexHolds(index, want) && !waitingOnSent(index)) {
    $('mods-acts').innerHTML = draw.frontActs({ cats: cats(), filter: feedFilter, finding });
    $('main').innerHTML = draw.frontChips({ cats: cats(), filter: feedFilter, here }, drawing()) + '<p class="dim">Loading…</p>';
    say('Loading the latest posts');
  }
  const idx = await readIndex(want);
  if (mineView !== view) return;
  if (waitingOnSent(idx)) setTimeout(() => { if (mineView === view) showForum(); }, SENT_EVERY_MS);
  // Who moderates what is on screen. Showing the whole forum, that is
  // whoever moderates its categories — otherwise a moderator looking at
  // everything would look like a stranger. The line under the rule says who
  // they are: painted from the forum's own list when the page loads, and kept
  // with the categories' lists, which is where a moderator added while you
  // read appears first.
  moderators = draw.moderatorsOf(idx, here);
  if (!keep) paintMods(moderators);
  const rows = draw.frontRows({ cats: cats(), idx, filter: feedFilter, finding, order, down, shown });
  // A members-only category that will not answer this reader looks exactly
  // like an empty one. Ask it a question only a member can have answered.
  const membersOnly = !rows.topics.length && !!here
    && !(await read.topics(here.base)).total && !(await read.canRead(here.base));
  // Every row's author and digest at once rather than one row at a time: they
  // do not depend on each other, and waiting for each in turn is the whole of
  // the delay between choosing a category and seeing it.
  const facts = await draw.rowFacts(rows.page, cats(), authorOnce, digestOnce);
  if (mineView !== view) return;
  const out = draw.drawFront({ forum, cats: cats(), filter: feedFilter, finding, order, down, rows, facts, membersOnly, front }, drawing());
  document.title = out.title;
  say(out.say);
  if (!keep || out.fresh) {
    crumbs(trail);
    $('mods-acts').innerHTML = out.acts;
    $('main').innerHTML = out.main;
  }
  // The box takes the keyboard only when there is something in it to scroll:
  // a tab stop that does nothing is one more press between a reader and the page.
  const scroller = $('main').querySelector('.scroll');
  if (scroller) { if (scroller.scrollHeight > scroller.clientHeight) scroller.tabIndex = 0; else scroller.removeAttribute('tabindex'); }
}

async function showTopic(slug, tid, atPost = null) {
  const drawn = drawnFor('topic', slug, tid);
  const keep = first && asDrawn(drawn);
  first = false;
  const cat = catBySlug(slug);
  if (!cat) { $('main').innerHTML = '<p class="err">No such category.</p>'; return; }
  const topicId = cat.base + 'ap/topic/' + tid;
  let got = drawn?.topic?.topicId === topicId ? drawn.topic : null;
  if (!got) {
    crumbs([['Home', addr.front()], [cat.name, addr.cat(slug)], ['topic', null]]);
    $('main').innerHTML = '<p class="dim">Loading…</p>';
    say('Loading the topic');
    got = await draw.readTopic(read, cat, tid);
  }
  moderators = got.moderators || [];
  const { t, posts = [] } = got;
  // Opening a topic reads it, up to the newest post that was in it.
  if (t) seen?.markRead(topicId, seen.newest(posts));
  const placed = new Set(t?.posts || []);
  // A post of this reader's own that has waited an hour can be sent again.
  const resendable = (w) => !!podAcct && (w.author === podAcct.handle || w.author === podAcct.actor)
    && Date.now() - Date.parse(w.at) > RESEND_AFTER_MS;
  const pending = t ? waiting(topicId).filter(w => !placed.has(w.id))
    .map(w => ({ id: w.id, author: w.author, published: w.at, content: toHtml(w.text), resend: resendable(w) })) : [];
  // A closed topic takes nothing more: the forum would refuse it anyway, so
  // the drawing offers no way to add to it.
  const out = draw.drawTopic({ cat, slug, ...got, pending }, drawing());
  document.title = out.title;
  if (!keep || pending.length) {
    crumbs([['Home', addr.front()], [cat.name, addr.cat(slug)], [t ? t.name : 'topic', null]]);
    $('main').innerHTML = out.main;
  }
  say(out.say);
  if (!t) return;
  replyBox({ cat, title: 'Reply', inReplyToUrl: t.posts[t.posts.length - 1] || null, topicId });
  $('reply-row').hidden = true;      // the thread's own button opens it
  // Arriving from the front page: the post that was linked to, in view and
  // marked, rather than the top of a thread it sits somewhere inside.
  if (atPost) {
    const el = document.getElementById('p-' + atPost);
    // Taken to, not just scrolled to: a keyboard and a screen reader both land
    // on the post that was linked, rather than at the top of the thread.
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('picked'); el.tabIndex = -1; el.focus(); }
  }
}

// The reply box: signed out, it offers the two ways in; signed in, it posts.
let replyCtx = null;
function replyBox(ctx) {
  replyCtx = ctx;
  $('reply-row').hidden = false;
  $('reply-open').textContent = ctx.title;
  $('reply-title').textContent = ctx.title;
  $('reply-err').textContent = '';
  const acct = account();
  $('reply-signed-out').hidden = !!acct;
  $('reply-signed-in').hidden = !acct;
  $('fedi-note').textContent = '';
  editing = null;
  $('reply-send').textContent = 'Post reply';
  $('topic-title-row').hidden = !!ctx.topicId;
  $('reply-text').placeholder = ctx.topicId ? 'Write your reply' : 'Your opening post';
  $('reply-text-label').textContent = ctx.topicId ? 'Your reply' : 'Your opening post';
  if (acct) $('reply-as').textContent = acct.handle;
}

// From a handle to a way in. A server that speaks the Mastodon API signs the
// reader in here; a Lemmy server takes part by its own community address; any
// other account posts from where it is, naming the category. A bare WebID —
// typed, not a handle — signs in with no Fediverse account at all: the post
// shows on this site, but reaches nobody's Mastodon feed, because nothing
// vouches for its author out there. Nobody is signed up for a Fediverse
// account behind their back to avoid that; it is the deliberate trade of
// posting from a WebID alone.
async function signIn(handleInput, noteId = 'fedi-note') {
  const typed = String(handleInput || '').trim();
  if (/^https?:\/\//u.test(typed)) {
    $(noteId).textContent = 'Asking your pod…';
    try {
      const { authorizationUrl, storageRoot } = await pod.signInWithWebId(typed, signInAddress);
      sessionStorage.setItem('bb:return', whereNow());
      sessionStorage.setItem('bb:pod', JSON.stringify({ handle: authorLabel(typed), actor: typed, podHome: storageRoot }));
      location.href = authorizationUrl;
    } catch (e) { $(noteId).textContent = e.message; }
    return;
  }
  const host = hostOfHandle(handleInput);
  if (!host) throw new Error('a handle looks like @you@your.server');
  const at = replyCtx?.cat ? handleOf(replyCtx.cat) : 'the category';
  $(noteId).textContent = `Asking ${host}…`;
  const handle = String(handleInput).trim().replace(/^@/u, '').split('@')[0];
  const said = await serverKind(host, front, undefined, handle);
  const kind = said.kind;
  if (kind === 'mastodon-api') {
    sessionStorage.setItem('bb:return', whereNow());
    location.href = await login.begin(host);
    return;
  }
  const note = $(noteId);
  note.textContent = '';
  if (kind === 'fedipod') {
    if (!said.issuer || !said.actor) throw new Error(`${host} did not say where ${handleInput} signs in`);
    sessionStorage.setItem('bb:return', whereNow());
    sessionStorage.setItem('bb:pod', JSON.stringify({ handle: `@${handle}@${host}`, actor: said.actor, podHome: said.podHome }));
    location.href = await pod.signIn({ issuer: said.issuer, redirectUri: signInAddress });
    return;
  }
  note.textContent = kind === 'lemmy'
    ? `From ${host}, subscribe to !${at.replace(/^@/u, '')} and post there; it arrives here.`
    : kind === 'invalid'
      ? 'A handle looks like @you@your.server.'
      : `${host} does not offer a sign-in this page can use. Post from your account there, naming ${at}, and it arrives here.`;
}

// A box in front of the page is movable: press its heading and drag. It
// stays where it was put until it is closed, and it cannot be dragged off
// the edge and lost.
function movable(dlg) {
  const grip = dlg.querySelector('h2');
  if (!grip || grip.dataset.movable) return;
  grip.dataset.movable = '1';
  grip.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    const box = dlg.getBoundingClientRect();
    const from = { x: e.clientX - box.left, y: e.clientY - box.top };
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const x = Math.min(Math.max(0, ev.clientX - from.x), window.innerWidth - box.width);
      const y = Math.min(Math.max(0, ev.clientY - from.y), window.innerHeight - 40);
      dlg.classList.add('moved');
      dlg.style.left = `${x}px`;
      dlg.style.top = `${y}px`;
    };
    const done = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', done); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', done);
  });
}

// Anything the page opens in front of itself goes through here.
function openPanel(title, html) {
  $('panel-title').textContent = title;
  $('panel-body').innerHTML = html;
  $('panel-err').textContent = '';
  const dlg = $('panel');
  dlg.classList.remove('moved');
  dlg.style.left = dlg.style.top = '';
  movable(dlg);
  dlg.showModal();
}
$('panel-close').addEventListener('click', () => $('panel').close());

// A panel is a box in front of the page, and it sits OUTSIDE <main> — so the
// page's own click handler never saw the buttons in one, and pressing Add did
// nothing at all. Its buttons are settings acts like any other.
$('panel').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  const act = b?.dataset.act || '';
  if (act.startsWith('set-') || act.startsWith('add-') || act.startsWith('drop-')) return onSettings(b);
  return undefined;
});

$('reply-open').addEventListener('click', () => { openReply({ inReplyToUrl: replyCtx?.inReplyToUrl || null }); });
$('main').addEventListener('click', async (e) => {

  // Every button in the page that names an action, wherever it sits: a
  // post's row, a topic's row, or the categories line.
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.closest('[data-post]')?.dataset.post;
  const act = b.dataset.act;
  if (act === 'reply') return openReply({ inReplyToUrl: id });
  if (act === 'edit') return openEdit(id);
  if (act === 'delete') return removePost(id);
  if (act === 'share') return share(id, b);
  if (act === 'report') return report(id);
  if (act === 'remove') return modRemove(id);
  if (act === 'resend') return resendPost(id, b);
  const topic = b.dataset.topic || b.closest('[data-topic]')?.dataset.topic;
  if (act === 'more') { shown += 30; return showForum(); }
  if (act === 'order') {
    const col = b.dataset.order;
    if (order === col) down = !down; else { order = col; down = true; }
    shown = 30;
    return showForum();
  }
  // Anything that acts as somebody asks who that is first, and remembers what
  // was pressed so signing in finishes it.
  if (GATED[act] && !account()) { rememberIntent(b); return askToSignIn(GATED[act]); }
  if (act === 'join' || act === 'leave') return joinOrLeave(b.dataset.cat, act === 'join');
  if (act === 'ask-join') return askToJoin(b.dataset.cat);
  if (act === 'admit') return modAdmit(id, b.closest('[data-cat]')?.dataset.cat);
  if (act === 'removepost') return modRemoveFromQueue(b.dataset.post, b.closest('[data-cat]')?.dataset.cat);
  if (act === 'save' || act === 'unsave') return saveOrNot(id, act === 'save');
  if (act.startsWith('vote-')) return voteOn(id, act.slice(5), b.dataset.was || 'none');
  if (act === 'approve' || act === 'refuse') return modHeld(id, b.closest('[data-cat]')?.dataset.cat, act === 'approve');
  if (act === 'ban') return modBan(b.dataset.who, b.closest('[data-cat]')?.dataset.cat);
  if (act === 'open-mods') {
    const named = await Promise.all(moderators.map(m => modLabel(m)));
    return openPanel('Moderators', `<p class="hint">${named.map(esc).join(', ') || 'nobody yet'}</p>
      <div class="row oneline">
        <label for="set-mod">Their handle</label>
        <input type="text" id="set-mod" placeholder="@mei@their.server">
        <button data-act="add-mod">Add</button><button data-act="drop-mod">Remove</button>
      </div>
      <p class="hint">Adding somebody makes them a moderator and lets them read the queue.
        The queue is held under the pod's own access rule, and a rule names a person by the
        WebID of their pod: a Mastodon account has none, so it can moderate and have its
        asks acted on, but it cannot open the queue.</p>`);
  }
  if (act === 'open-members') {
    const cat = cats().find(c => c.id === b.dataset.cat);
    if (!cat) return;
    return openPanel(`Members of ${cat.name}`, `<p class="hint">Naming anyone here closes this category to everyone else. A member is named by their WebID, which is what a pod's own rule can grant.</p>
      <div class="row">
        <label for="set-member">Their WebID</label>
        <input type="text" id="set-member" class="cat-member" data-cat="${esc(cat.id)}" placeholder="https://someone.example/profile/card#me">
        <button data-act="add-member" data-cat="${esc(cat.id)}">Let them in</button>
        <button data-act="drop-member" data-cat="${esc(cat.id)}">Take them out</button>
      </div>`);
  }
  if (act.startsWith('set-') || act.startsWith('add-') || act.startsWith('drop-')) return onSettings(b);
  // Search asks for the room to type in rather than holding it open: the
  // button becomes the box, and an empty box left alone becomes the button.
  if (act === 'search') {
    const box = $('find');
    if (!box) return undefined;
    b.hidden = true;
    box.hidden = false;
    box.focus();
    return undefined;
  }
  if (act === 'post-to') return postToTimeline(b.dataset.to, b.dataset.handle || '');
  if (act === 'newpost') return openReply({ inReplyToUrl: replyCtx?.inReplyToUrl || null });
  if (act === 'newtopic') {
    const cat = catBySlug(b.dataset.slug);
    if (!cat) return;
    replyBox({ cat, title: 'Start a topic', inReplyToUrl: null, topicId: null });
    $('reply-row').hidden = true;
    return openReply({ inReplyToUrl: null });
  }
  if (act === 'rename') return modRename(topic);
  if (act === 'pin' || act === 'unpin') return modPin(topic, act === 'pin');
  if (act === 'sitepin' || act === 'siteunpin') return modPin(topic, act === 'sitepin', true);
  if (act === 'lock' || act === 'unlock') return modLock(topic, act === 'lock');
  if (act === 'droptopic') return modDropTopic(topic);
});

// The dialog takes the focus when it opens and hands it back to whatever
// opened it when it closes, so a keyboard is never left where the page was.
let reopener = null;
// What a private category actually promises the person about to write in it.
// Said in the box, at the moment it matters, because the word Private on a
// button is a claim and this is the whole of what is behind it.
function sayPrivacy() {
  const note = $('reply-private');
  if (!note) return;
  const cat = replyCtx?.cat;
  if (!cat?.private) { note.hidden = true; note.textContent = ''; return; }
  note.hidden = false;
  note.textContent = `${cat.name} is private. This is written into your own pod for its members to read, `
    + 'and goes to nobody else. Your followers are not sent it and cannot read it. '
    + 'Anyone admitted later can read it, and anyone admitted now can copy it.';
}

function showDialog() {
  sayPrivacy();
  reopener = document.activeElement;
  $('reply-dlg').showModal();
  (account() ? $('reply-text') : $('fedi-handle'))?.focus();
}
$('reply-dlg').addEventListener('close', () => { reopener?.focus?.(); reopener = null; });

// The dialog, armed for what it is about to do.
function openReply({ inReplyToUrl = null } = {}) {
  movable($('reply-dlg'));
  editing = null;
  if (replyCtx) replyCtx.inReplyToUrl = inReplyToUrl;
  $('reply-title').textContent = replyCtx?.title || 'Reply';
  $('reply-send').textContent = 'Post reply';
  $('reply-err').textContent = '';
  showDialog();
}

let editing = null;
async function openEdit(id) {
  const p = await read.post(replyCtx.cat.base, id);
  if (!p) { $('reply-err').textContent = 'that post is not readable here'; return; }
  editing = { id, page: p.page || null };
  $('reply-title').textContent = 'Edit your post';
  $('reply-text-label').textContent = 'Your post';
  $('reply-send').textContent = 'Save';
  $('reply-err').textContent = '';
  $('topic-title-row').hidden = true;
  // Back to the words, from the HTML the post is kept as.
  if (p.source) {
    $('reply-text').value = p.source;
  } else {
    // Written before the forum kept the source, or written elsewhere: the
    // words are recovered from the HTML, losing whatever marked them up.
    const d = document.createElement('div');
    d.innerHTML = body(p, replyCtx.cat);
    $('reply-text').value = [...d.querySelectorAll('p')].map(x => x.textContent.trim()).join('\n\n') || d.textContent.trim();
  }
  showDialog();
}

// The address of this post on this site, for pasting anywhere. The thread is
// what a person wants to open, and the post is named in it.
async function share(id, btn) {
  const tid = (replyCtx?.topicId || '').split('/').pop() || (await topicOf(id)) || '';
  const to = addr.topic(replyCtx.cat.slug, tid, await cacheKey(id));
  const link = place.root ? location.origin + to : `${location.origin}${location.pathname}${location.search}${to}`;
  try { await navigator.clipboard.writeText(link); btn.textContent = 'Copied'; say('Link copied'); }
  catch { window.prompt('Copy this address', link); return; }
  setTimeout(() => { btn.textContent = 'Share'; }, 1500);
}

// Which topic holds a post, when the page is showing a category rather than a
// thread: the card sits inside the topic's own list item.
async function topicOf(id) {
  const li = [...document.querySelectorAll('ul.list li')].find(el => el.querySelector(`[data-post="${CSS.escape(id)}"]`));
  const href = li?.querySelector('a.title')?.getAttribute('href') || '';
  if (href.startsWith('#/t/')) return href.split('/')[3] || null;
  return place.root ? viewOfPath(new URL(href, location.href).pathname, place.root).tid || null : null;
}

// One of this reader's own posts the forum never took in, handed to it again.
// It stays marked as waiting until the forum lists it.
async function resendPost(id, btn) {
  const cat = replyCtx?.cat;
  if (!cat || !podAcct || !id) return;
  btn.disabled = true;
  try {
    const inbox = await pod.podInboxOf(cat.id);
    if (!inbox) throw new Error('the forum did not say where to send it');
    await pod.resend({ actor: podAcct.actor, podHome: podAcct.podHome, id, inbox });
    say('Sent again. It shows here once the forum has it.');
    sent = { id, until: Date.now() + SENT_WAIT_MS };
    forgetIndex();
    freshRead = true;
    try { await route(); } finally { freshRead = false; }
  } catch (e) { btn.disabled = false; alert(e.message); }
}

async function report(id) {
  const why = window.prompt('Report this post to the moderators. What is wrong with it?');
  if (why === null) return;
  try {
    const cat = replyCtx.cat;
    const inbox = await pod.podInboxOf(cat.id);
    const who = podAcct?.actor || login.account()?.url;
    await pod.report({ actor: who, object: id, category: cat.id, inbox, why });
    alert('Reported. A moderator will see it in the forum\'s queue.');
  } catch (e) { alert(e.message); }
}

async function asksTo(activity, forCat = null) {
  if (!podAcct) throw new Error('moderating from here needs your pod account');
  const cat = forCat || replyCtx?.cat;
  if (!cat) throw new Error('this is not in a category the page knows about — open the topic and try from there');
  // Which step failed, not only that one did. Three requests go out here — ask
  // the Gateway where the forum takes mail, write the request on your own pod,
  // hand it to the forum — and each can fail with the browser's bare "Failed to
  // fetch", which on its own says nothing about which address would not answer.
  // The same reason voteOn says it.
  let step = 'finding where the forum takes mail';
  try {
    const inbox = await pod.podInboxOf(cat.id);
    if (!inbox) throw new Error('the forum did not say where to send it');
    // moderate() names its own two requests, so nothing is added over the top.
    step = 'sending the request';
    await pod.moderate({ actor: podAcct.actor, podHome: podAcct.podHome, inbox, activity });
  } catch (e) {
    throw new Error(`${e.message} — while ${step}`);
  }
  alert('Sent to the forum. It takes effect once the forum has checked who asked.');
}

// A post out of its topic: a Delete whose origin is the topic it is leaving.
async function modRemove(id) {
  if (!confirm('Remove this post from the topic?')) return;
  const topicId = replyCtx.topicId || (replyCtx.cat.base + 'ap/topic/' + (await topicOf(id)));
  try { await asksTo({ type: 'Delete', object: id, origin: topicId }); } catch (e) { alert(e.message); }
}

// A topic's name belongs to the topic, and only the forum writes it.
async function modRename(topicId) {
  const now = document.querySelector('.topline h1')?.textContent || '';
  const name = window.prompt('Name for this topic', now);
  if (name === null || !name.trim()) return;
  try { await asksTo({ type: 'Update', object: { id: topicId, name: name.trim() } }); } catch (e) { alert(e.message); }
}

// Pinned topics are the category's featured collection.
// Closed to further replies. `closed` is AS2's own word for a collection
// that takes no more, so a reader on any server can see it too.
// Joining is a Follow to the category and leaving undoes it. A category
// carries its members' posts and nobody else's, so this is what makes
// posting from here work at all.
async function joinOrLeave(categoryId, on) {
  const cat = cats().find(c => c.id === categoryId);
  if (!cat) return;
  if (!podAcct) {
    alert(account()
      ? 'Joining is sent from your own pod, so it needs a pod account — sign out and sign in with your @you@your-pod handle.'
      : 'Joining needs an account.');
    return;
  }
  try {
    const inbox = await pod.podInboxOf(cat.id);
    const ok = on
      ? await pod.join({ actor: podAcct.actor, category: cat.id, inbox })
      : await pod.leave({ actor: podAcct.actor, category: cat.id, inbox });
    if (!ok) throw new Error('the forum did not take it');
    if (on) own().join(cat.id); else own().leave(cat.id);
    forgetIndex();
    await showForum();
  } catch (e) { alert(e.message); }
}

// --- signing in where the reader is, rather than where the form is ---
//
// Everything below the counts needs an account: voting, joining, saving,
// asking to be let into a private category. A reader without one used to see
// no button at all for some of these and a bare refusal for others, and the
// way in was hidden inside the Reply box. Now the button is there, pressing it
// asks who you are, and the thing you pressed happens when you come back.
//
// Signing in leaves the page — it is somebody else's login — so what you were
// doing has to outlive the trip. It goes in sessionStorage beside `bb:return`,
// which is how the hash already survives it.
const GATED = {
  'vote-up': 'vote on a post', 'vote-down': 'vote on a post', 'vote-none': 'take back your vote',
  join: 'join a category', leave: 'leave a category', 'ask-join': 'ask to join a category',
  save: 'save a post', unsave: 'remove a saved post',
};

function rememberIntent(b) {
  const d = b.dataset;
  sessionStorage.setItem('bb:intent', JSON.stringify({
    // The SAME places the dispatcher reads them from, or the replay acts on a
    // different post from the one that was pressed: the id is on the enclosing
    // `data-post`, never on the button.
    act: d.act, id: b.closest('[data-post]')?.dataset.post || null,
    cat: d.cat || b.closest('[data-cat]')?.dataset.cat || null,
    was: d.was || null,
  }));
}

// Open the sign-in dialog, saying what it is for. `why` is the plain-English
// name of the action from GATED, so the reader is told what signing in buys
// them rather than being asked for a handle out of nowhere.
function askToSignIn(why) {
  $('signin-why').textContent = why ? `Sign in to ${why}.` : '';
  $('signin-note').textContent = '';
  $('signin-dlg').showModal();
  $('signin-handle').focus();
}

// Back from the login with something to finish. Runs the same handler the
// click would have run, so there is one path through each action and not two.
async function replayIntent() {
  let want = null;
  try { want = JSON.parse(sessionStorage.getItem('bb:intent') || 'null'); } catch { /* unreadable */ }
  sessionStorage.removeItem('bb:intent');
  if (!want || !account()) return;
  if (String(want.act).startsWith('vote-')) return voteOn(want.id, want.act.slice(5), want.was || 'none');
  if (want.act === 'join' || want.act === 'leave') return joinOrLeave(want.cat, want.act === 'join');
  if (want.act === 'ask-join') return askToJoin(want.cat);
  if (want.act === 'save' || want.act === 'unsave') return saveOrNot(want.id, want.act === 'save');
}

// A vote goes to the category as a Like or a Dislike, and the Undo of
// whichever was cast takes it back. The forum counts them; this browser only
// remembers which way this reader went, so the buttons can say so.
async function voteOn(postId, way, was) {
  // A vote is signed by the pod that casts it, so a Fediverse-only sign-in
  // cannot cast one. Said plainly: the reader has just signed in and is being
  // refused, and "needs your pod account" on its own does not say what to do.
  if (!podAcct) {
    alert(account()
      ? 'A vote is sent from your own pod, so it needs a pod account — sign out and sign in with your @you@your-pod handle.'
      : 'Voting needs an account.');
    return;
  }
  const cat = replyCtx?.cat || cats().find(c => c.slug === feedFilter) || cats()[0];
  if (!cat) return;
  let step = 'finding where the forum takes mail';
  try {
    const inbox = await pod.podInboxOf(cat.id);
    if (!inbox) throw new Error('the forum did not say where to send it');
    step = `sending the vote to ${new URL(inbox).host}`;
    await pod.vote({ actor: podAcct.actor, post: postId, category: cat.id, inbox, way, was });
    own().vote(postId, way);
    forgetIndex();
    paintVote(postId, way, was);
    say(way === 'none' ? 'Vote taken back.' : 'Voted. The count follows once the forum has taken it.');
  } catch (e) {
    // Which step failed, not only that one did: "failed to fetch" on its own
    // says nothing about which address would not answer.
    alert(`${e.message} — while ${step}`);
  }
}

// A post on somebody's timeline: their inbox is asked for, the post is written
// in the sender's own public container, and handed over. Each way it can fail
// says which address would not answer, since a bare "failed to fetch" names
// none of them.
async function postToTimeline(to, handle) {
  const box = $('dm-text');
  const err = $('dm-err');
  const text = box?.value.trim();
  if (!err) return;
  if (!text) { err.className = 'err'; err.textContent = 'Write something first.'; return; }
  if (!podAcct) { err.className = 'err'; err.textContent = 'Posting to someone is done from your own pod account.'; return; }
  err.className = '';
  err.textContent = 'Posting…';
  try {
    // Their handle, for the mention the post carries. Nothing else about them
    // is needed: the sender's own agent works out where it goes and signs it.
    const card = await read.actorCard(to).catch(() => null);
    await pod.postTo({
      actor: podAcct.actor, podHome: podAcct.podHome, handle: podAcct.handle,
      to, toHandle: card?.handle || handle || '', front, text,
    });
    box.value = '';
    err.className = 'said';
    err.textContent = 'Handed to your own account. It goes out signed when your agent next reads its inbox.';
    say('Posted.');
  } catch (e) {
    err.className = 'err';
    err.textContent = e.message;
  }
}

// The reader's own vote, on the buttons they just pressed. The forum's count
// is the truth and follows when it has taken the vote; until then the page
// showed the row exactly as it was, so a vote looked like nothing happening.
function paintVote(postId, way, was) {
  const acts = document.querySelector(`.acts[data-post="${CSS.escape(postId)}"]`);
  const [upBtn, downBtn] = acts ? acts.querySelectorAll('button[data-act^="vote-"]') : [];
  if (!upBtn || !downBtn) return;
  const count = (b) => Number(String(b.textContent).replace(/[^0-9]/gu, '')) || 0;
  let up = count(upBtn);
  let down = count(downBtn);
  if (was === 'up') up -= 1;
  if (was === 'down') down -= 1;
  if (way === 'up') up += 1;
  if (way === 'down') down += 1;
  const set = (b, its, mark, n, label) => {
    b.dataset.act = `vote-${way === its ? 'none' : its}`;
    b.dataset.was = way;
    b.textContent = `${mark} ${Math.max(0, n)}`;
    b.classList.toggle('voted', way === its);
    if (way === its) b.setAttribute('aria-pressed', 'true'); else b.removeAttribute('aria-pressed');
    b.setAttribute('aria-label', way === its ? `Take back your vote ${label}` : `Vote ${label} this post`);
  };
  set(upBtn, 'up', '\u25B2', up, 'for');
  set(downBtn, 'down', '\u25BC', down, 'against');
}

// Asking to be let into a private category: the same Follow that joining
// sends, which a category approving its members holds for a moderator.
async function askToJoin(categoryId) {
  const cat = cats().find(c => c.id === categoryId);
  if (!cat || !podAcct) return;
  try {
    const inbox = await pod.podInboxOf(cat.id);
    await pod.join({ actor: podAcct.actor, category: cat.id, inbox });
    say('Asked. A moderator sees it in the forum\'s queue.');
    alert('Your request is with the moderators.');
  } catch (e) { alert(e.message); }
}

// Admitting somebody who asked: their follow is accepted, and in a private
// category their pod is granted the reading that membership means.
async function modAdmit(who, slug) {
  forgetIndex();   // whatever this does, the index behind it is now out of date
  const cat = cats().find(c => c.slug === slug) || replyCtx?.cat;
  if (!cat || !who) return;
  try {
    await asksTo({ type: 'Join', object: who }, cat);
    await asksTo({ type: 'Add', object: who, target: cat.base + 'ap/members' }, cat);
    say('Admitted. It takes effect once the forum has checked who asked.');
  } catch (e) { alert(e.message); }
}

// A bookmark is this reader's own note to come back to, in this browser.
function saveOrNot(postId, on) {
  const m = own();
  if (on) {
    const card = document.querySelector(`[data-post="${CSS.escape(postId)}"]`)?.closest('article');
    m.save({ id: postId, at: new Date().toISOString(), topic: replyCtx?.topicId || null,
      cat: replyCtx?.cat?.slug || null, text: (card?.querySelector('.body')?.textContent || '').trim().slice(0, 140) });
  } else m.unsave(postId);
  route();
}

// A held post: let through, or turned away. Both are asks like any other,
// published at the moderator's own pod and checked there.
async function modHeld(postId, slug, through) {
  forgetIndex();   // whatever this does, the index behind it is now out of date
  const cat = cats().find(c => c.slug === slug) || replyCtx?.cat;
  if (!cat) { alert('which category is that in?'); return; }
  try {
    await asksTo({ type: through ? 'Accept' : 'Reject', object: postId }, cat);
    say(through ? 'Let through. It is carried once the forum has checked who asked.' : 'Turned away.');
  } catch (e) { alert(e.message); }
}

// A reported post taken out of its topic, from the queue rather than from
// the thread: the topic it is in is the one the forum has it in.
async function modRemoveFromQueue(postId, slug) {
  forgetIndex();   // whatever this does, the index behind it is now out of date
  const cat = cats().find(c => c.slug === slug);
  if (!cat || !postId) return;
  if (!confirm('Remove this post from its topic?')) return;
  try {
    const copy = await read.post(cat.base, postId);
    if (!copy?.topic) throw new Error('the forum does not say which topic holds it');
    await asksTo({ type: 'Delete', object: postId, origin: copy.topic }, cat);
    say('Asked. It takes effect once the forum has checked who asked.');
  } catch (e) { alert(e.message); }
}

// Banning: the category blocks them, which is the whole of what a group can
// enforce — it stops carrying them and ends the following.
async function modBan(who, slug) {
  const cat = cats().find(c => c.slug === slug) || replyCtx?.cat;
  if (!cat || !who) return;
  if (!confirm(`Ban ${authorLabel(who)} from ${cat.name}? Their posts stop being carried.`)) return;
  try {
    await asksTo({ type: 'Block', object: who }, cat);
    say('Asked. It takes effect once the forum has checked who asked.');
  } catch (e) { alert(e.message); }
}

// The line naming who moderates, from actor ids: each one's own handle where
// something says it, and the address it was read from otherwise.
async function paintMods(ids) {
  if (!ids.length) return;
  $('mods-who').innerHTML = draw.modsWho(await Promise.all(ids.map(async (id) => ({ id, handle: await modLabel(id) }))));
}

// What to call a moderator: what the drawn page called them, the card the
// forum kept of them, then the actor's own word for it, and a name read off
// the address only when none of those answers.
const namedInPage = new Map((boot?.names || []).map(n => [n.id, n.handle]));
async function modLabel(actorId) {
  if (namedInPage.has(actorId)) return namedInPage.get(actorId);
  const cat = cats()[0];
  const card = cat ? await authorOnce(cat.base, actorId) : null;
  if (card?.handle) return card.handle;
  return (await read.actorHandle(actorId).catch(() => null)) || authorLabel(actorId);
}

// What a moderator types is a handle; what the wire names is the actor behind
// it. A server that will not say who that is stops the ask here, where the
// person who typed it is looking, rather than on the forum an hour later.
async function actorFor(typed) {
  if (!typed) return null;
  try { return await actorOfHandle(typed); } catch (e) { settingsSaid(e.message, true); return null; }
}

// Every settings change is an ordinary activity naming what it changes: a
// Create of a Group for a new category, an Update for a name, an Add or a
// Remove for who moderates and who may read.
// What came of a settings change, where the reader can see it: the line that
// reads aloud is invisible on the screen, so a change that worked looked
// exactly like a button that did nothing.
function settingsSaid(text, bad = false) {
  say(text);
  if ($('panel').open) {
    const box = $('panel-err');
    box.textContent = text;
    box.className = bad ? 'err' : 'said';
    return;
  }
  alert(text);
}

async function settingsAsk(...activities) {
  try {
    const inbox = await pod.podInboxOf(cats()[0]?.id || forum.id);
    for (const activity of activities) {
      await pod.moderate({ actor: podAcct.actor, podHome: podAcct.podHome, inbox, activity });
    }
    settingsSaid('Sent. It takes effect once the forum has checked who asked.');
  } catch (e) { settingsSaid(e.message, true); }
}

async function onSettings(b) {
  const act = b.dataset.act;
  const catId = b.dataset.cat;
  const val = (sel) => document.querySelector(sel)?.value.trim() || '';
  if (act === 'set-forum-name') {
    const name = val('#set-forum-name');
    if (name) await settingsAsk({ type: 'Update', object: { id: forum.id, name } });
  } else if (act === 'set-cat-name') {
    const name = document.querySelector(`.cat-name[data-cat="${CSS.escape(catId)}"]`)?.value.trim();
    if (name) await settingsAsk({ type: 'Update', object: { id: catId, name } });
  } else if (act === 'add-cat') {
    const slug = val('#set-new-slug').toLowerCase();
    const name = val('#set-new-name') || slug;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(slug)) { alert('a Fediverse username is lower-case letters, digits and hyphens'); return; }
    const priv = document.querySelector('input[name="set-new-private"]:checked')?.value === 'private';
    await settingsAsk({ type: 'Create', target: forum.id,
      object: { type: 'Group', preferredUsername: slug, name, ...(priv ? { manuallyApprovesFollowers: true } : {}) } });
  } else if (act === 'add-member' || act === 'drop-member') {
    const webid = document.querySelector(`.cat-member[data-cat="${CSS.escape(catId)}"]`)?.value.trim();
    const cat = cats().find(c => c.id === catId);
    if (webid && cat) await settingsAsk({ type: act === 'add-member' ? 'Add' : 'Remove', object: webid, target: cat.base + 'ap/members' });
  } else if (act === 'add-mod' || act === 'drop-mod') {
    const typed = val('#set-mod');
    if (!typed) { settingsSaid('Type a handle first, like @mei@their.server.', true); return; }
    const who = await actorFor(typed);
    if (!who) return;                       // actorFor has already said why
    // One handle says two things: who may ask for moderation, and whose pod
    // the rule on the queue names. The forum finds the pod behind the actor.
    // Moderators are the forum's, so the ask names the forum's list; the
    // forum writes every category's from it.
    const type = act === 'add-mod' ? 'Add' : 'Remove';
    await settingsAsk({ type, object: who, target: `${base}ap/administrators` },
      { type, object: who, target: `${base}mod/` });
  }
}

async function modLock(topicId, on) {
  // AS2 types `closed` as a TIME, so closing carries the moment it closed and
  // reopening REMOVES it — which ActivityPub spells as `null` (§6.3.1, partial
  // updates). It used to send `closed: false`, which is neither a time nor a
  // removal: it arrived as the text "false" typed as a date, and `!!"false"` is
  // true, so every reopen closed the topic again.
  //
  // The type is named because the reading is built from a graph, and a node
  // with nothing on it but an id collapses to a bare id — taking the removal
  // with it. A topic IS an OrderedCollection, which is what the forum publishes.
  try {
    await asksTo({ type: 'Update',
      object: { id: topicId, type: 'OrderedCollection', closed: on ? new Date().toISOString() : null } });
  } catch (e) { alert(e.message); }
}

async function modPin(topicId, on, wholeSite = false) {
  // Which featured collection it goes into says how far the pin reaches: the
  // category's, or the forum's own.
  const target = wholeSite ? base + 'ap/featured' : replyCtx.cat.base + 'ap/featured';
  try { await asksTo({ type: on ? 'Add' : 'Remove', object: topicId, target }); } catch (e) { alert(e.message); }
}

// A topic removed from the category is a topic gone (FEP-f15d).
async function modDropTopic(topicId) {
  if (!confirm('Delete this topic and every post in it?')) return;
  try { await asksTo({ type: 'Remove', object: topicId, target: replyCtx.cat.id }); } catch (e) { alert(e.message); }
}

async function removePost(id) {
  if (!confirm('Delete this post? Everywhere it has reached is told to remove it.')) return;
  try {
    const cat = replyCtx.cat;
    if (podAcct) {
      const inbox = await pod.podInboxOf(cat.id);
      await pod.remove({ actor: podAcct.actor, podHome: podAcct.podHome, id, category: cat.id,
        categoryBase: cat.base, isPrivate: !!cat.private, inbox });
    } else {
      const p = await read.post(cat.base, id);
      await login.remove({ url: p?.page || id });
    }
    forgetIndex();
    await route();
  } catch (e) { alert(e.message); }
}
$('reply-cancel').addEventListener('click', () => $('reply-dlg').close());
// Open or private is the forum's setting, changed here and nowhere else:
// nobody joining, and nobody being named a member, ever moves a category
// between the two.
$('main').addEventListener('change', async (e) => {
  const r = e.target;
  if (r?.dataset?.act !== 'set-cat-private' || !r.checked) return;
  const cat = cats().find(c => c.id === r.dataset.cat);
  if (!cat) return;
  const priv = r.value === 'private';
  if (priv === !!cat.private) return;
  await settingsAsk({ type: 'Update', object: { id: cat.id, manuallyApprovesFollowers: priv } });
  cat.private = priv;
});

let findTimer = null;
function onFind(e) {
  if (e.target?.id !== 'find') return;
  finding = e.target.value;
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const where = e.target.selectionStart;
    await showForum();
    const box = document.getElementById('find');
    if (box) { box.focus(); box.setSelectionRange(where, where); }
  }, 250);
}
$('main').addEventListener('input', onFind);

// The moderators row is above <main>, so the page's own handlers never see the
// controls at its end: they are the same acts, listened for here.
$('mods-line').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'search') {
    const box = $('find');
    if (!box) return;
    b.hidden = true;
    box.hidden = false;
    box.focus();
    return;
  }
  if (b.dataset.act === 'newtopic') {
    const cat = catBySlug(b.dataset.slug);
    if (!cat) return;
    replyBox({ cat, title: 'Start a topic', inReplyToUrl: null, topicId: null });
    $('reply-row').hidden = true;
    openReply({ inReplyToUrl: null });
  }
});
$('mods-line').addEventListener('input', onFind);
$('mods-line').addEventListener('focusout', onFindOut);

// Nothing typed and the reader has gone elsewhere: the row takes its width
// back. Something typed stays open, so what is being searched for is visible.
function onFindOut(e) {
  if (e.target?.id !== 'find' || e.target.value.trim()) return;
  const button = document.querySelector('button[data-act="search"]');
  if (!button) return;
  e.target.hidden = true;
  button.hidden = false;
}
$('main').addEventListener('focusout', onFindOut);

$('reply-image').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  const said = $('reply-image-said');
  if (!file) return;
  if (!podAcct) { said.textContent = 'adding an image needs your pod account'; e.target.value = ''; return; }
  said.textContent = 'putting it in your pod…';
  try {
    const url = await pod.upload({ actor: podAcct.actor, podHome: podAcct.podHome, file });
    const box = $('reply-text');
    const alt = file.name.replace(/\.[^.]+$/u, '').replace(/[-_]+/gu, ' ');
    box.value = `${box.value}${box.value && !box.value.endsWith('\n') ? '\n\n' : ''}![${alt}](${url})\n`;
    said.textContent = 'added';
    box.focus();
  } catch (err) { said.textContent = err.message; }
  e.target.value = '';
});

$('fedi-login').addEventListener('click', async () => {
  $('reply-err').textContent = '';
  $('fedi-login').disabled = true;
  try { await signIn($('fedi-handle').value); } catch (e) { $('reply-err').textContent = e.message; }
  $('fedi-login').disabled = false;
});
$('fedi-handle').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('fedi-login').click(); });

// The stand-alone sign-in. Same signIn() as the Reply box's, reporting into
// this dialog's own line rather than the other one's.
$('signin-go').addEventListener('click', async () => {
  $('signin-note').textContent = '';
  $('signin-go').disabled = true;
  try { await signIn($('signin-handle').value, 'signin-note'); } catch (e) { $('signin-note').textContent = e.message; }
  $('signin-go').disabled = false;
});
$('signin-handle').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('signin-go').click(); });
// Cancelling drops what was remembered: the reader said no, and it should not
// happen to them the next time they sign in for something else.
$('signin-cancel').addEventListener('click', () => { sessionStorage.removeItem('bb:intent'); $('signin-dlg').close(); });
$('signin-dlg').addEventListener('cancel', () => sessionStorage.removeItem('bb:intent'));
async function signOutOfEverything() {
  if (podAcct) { await pod.signOut(); podAcct = null; localStorage.removeItem('bb:acct'); sessionStorage.removeItem('bb:pod'); } else login.signOut();
  if (replyCtx) replyBox(replyCtx);
  paintWho();
}
$('masto-logout').addEventListener('click', signOutOfEverything);

$('who-act').addEventListener('click', async () => {
  if (!account()) return askToSignIn('take part, and to moderate if you are a moderator');
  await signOutOfEverything();
  say('Signed out.');
  route();
});

async function saveEdit({ body }) {
  const cat = replyCtx.cat;
  if (podAcct) {
    const inbox = await pod.podInboxOf(cat.id);
    return pod.edit({ actor: podAcct.actor, podHome: podAcct.podHome, id: editing.id, text: body, category: cat.id,
      categoryBase: cat.base, isPrivate: !!cat.private, inbox });
  }
  return login.edit({ url: editing.page || editing.id, text: body });
}

// A post written into the reader's own pod and announced to the forum. The
// category is named on its own pod, which is where a delivery is taken.
async function postFromPod({ topic, body }) {
  const cat = replyCtx.cat;
  const inbox = await pod.podInboxOf(cat.id);
  if (!inbox) throw new Error('the forum did not say where to send it');
  // Posting in an open category joins it on the way past, which is what makes
  // the post carry. A private one is joined by asking and being admitted, so
  // the post is refused here instead, and says so.
  if (!cat.private) await pod.join({ actor: podAcct.actor, category: cat.id, inbox });
  return pod.post({
    actor: podAcct.actor, podHome: podAcct.podHome, category: cat.id, categoryBase: cat.base,
    categoryHandle: handleOf(cat), isPrivate: !!cat.private, inbox,
    topic, text: body, inReplyTo: replyCtx.inReplyToUrl,
    context: replyCtx.topicId ? replyCtx.topicId : null,
  });
}
$('reply-send').addEventListener('click', async () => {
  if (!replyCtx) return;
  const body = $('reply-text').value.trim();
  if (!body) return;
  // A Mastodon post has no topic name to give: its first line stands in for
  // one, which is all that server can say. A pod post names the topic on the
  // activity that opens it, and its words are only its words.
  // The topic's name, asked for only when a topic is being opened; the
  // post's own title, which any post may have and any edit may change.
  const topic = !editing && !replyCtx.topicId ? $('topic-title').value.trim() : '';

  const text = topic ? `${topic}\n\n${body}` : body;
  $('reply-err').textContent = '';
  $('reply-send').disabled = true;
  try {
    const made = editing
      ? await saveEdit({ body })
      : podAcct
        ? await postFromPod({ topic, body })
        : await login.post({ text, mention: handleOf(replyCtx.cat), inReplyToUrl: replyCtx.inReplyToUrl });
    const acct = account();
    if (!editing && replyCtx.topicId) remember(replyCtx.topicId, { id: made.uri || made.url, author: acct.url || acct.handle, text, at: new Date().toISOString() });
    $('reply-text').value = '';
    $('topic-title').value = '';
    $('reply-dlg').close();
    if (!editing && (made?.uri || made?.url)) sent = { id: made.uri || made.url, until: Date.now() + SENT_WAIT_MS };
    forgetIndex();
    freshRead = true;
    try { await route(); } finally { freshRead = false; }
  } catch (e) { $('reply-err').textContent = e.message; }
  $('reply-send').disabled = false;
});

// Back to where the reader was before signing in, with the sign-in's own part
// of the address gone, so a reload does not replay it.
function goBack(query) {
  const back = sessionStorage.getItem('bb:return') || '';
  sessionStorage.removeItem('bb:return');
  const cut = back.indexOf('#');
  const [path, hash] = back.startsWith('/') ? [cut < 0 ? back : back.slice(0, cut), cut < 0 ? '' : back.slice(cut)] : [location.pathname, back];
  history.replaceState(null, '', `${path}${query ? '?' + query : ''}${hash}`);
}

// Back from the reader's server with a code: finish the sign-in, then clean
// the address so a reload does not replay it.
(async () => {
  // Back from a pod's sign-in: the session is this browser's, and the handle
  // it belongs to was put aside before leaving.
  // A reader who signed in stays signed in: the pod session lives in this
  // browser, and the handle it belongs to is kept beside it.
  const kept = localStorage.getItem('bb:acct');
  if (kept && !sessionStorage.getItem('bb:pod')) {
    try {
      const s = await pod.session();
      if (s) { podAcct = { ...JSON.parse(kept), webId: s.webId }; read = makeReader(s); }
      else localStorage.removeItem('bb:acct');
    } catch { localStorage.removeItem('bb:acct'); }
  }
  const waiting = sessionStorage.getItem('bb:pod');
  if (waiting) {
    try {
      const who = JSON.parse(waiting);
      const s = params.get('code') ? await pod.complete(location.href) : await pod.session();
      if (s) {
        podAcct = { ...who, webId: s.webId };
        read = makeReader(s);
        try { localStorage.setItem('bb:acct', JSON.stringify(who)); } catch { /* blocked storage */ }
        sessionStorage.removeItem('bb:pod');
        params.delete('code'); params.delete('state'); params.delete('iss');
        goBack(String(params));
      }
    } catch (e) { $('reply-err').textContent = e.message; }
  }
  const code = params.get('code');
  const state = params.get('state');
  if (code && state) {
    try {
      await login.complete({ state, code });
      params.delete('code'); params.delete('state');
      goBack(String(params));
    } catch (e) { $('reply-err').textContent = e.message; }
  }
  // Sign-up lives at the Gateway, which is this page's own site or the one it is a face of.
  $('fedipod-signup').href = front + '/new-account';
  // A link to a post on the page being read moves to it; anything else is a
  // view of its own.
  window.addEventListener('hashchange', () => { if (viewKey() !== routed) route(); });
  window.addEventListener('popstate', () => route());
  // At the forum's own host, going between the front page and a category is
  // a different filter on what the page already holds: no load and no reads,
  // as long as it holds it.
  if (place.root) {
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const to = new URL(a.getAttribute('href'), location.href);
      if (to.origin !== location.origin || to.search || to.hash) return;
      const v = viewOfPath(to.pathname, place.root);
      const filtering = to.pathname === place.root || v.kind === 'cat';
      if (!filtering || !indexHolds(index, Math.min(300, shown * 5))) return;
      e.preventDefault();
      history.pushState(null, '', to.pathname);
      route();
    });
  }
  await load();
  // Whatever the reader pressed before being asked to sign in. After `load`,
  // because voting and joining both need the categories to be known.
  await replayIntent();
})();
