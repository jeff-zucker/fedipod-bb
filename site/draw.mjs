// draw.mjs — the forum's public views as the page and the server that draws
// it both show them: what the front page, a category and a topic read, and
// the markup each is drawn as. Plain strings from plain data, with no
// document to hand, so a server draws exactly what a browser does. Runs in a
// browser and in Node alike.

import { authorLabel, cacheKey, cleanHtml, inTurn } from './read.mjs';

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };

// Text with its markup taken off, for a title or a description.
export function plainText(html, max = 0) {
  const ents = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
  const s = String(html || '').replace(/<[^>]*>/gu, ' ').replace(/&(amp|lt|gt|quot|#39|nbsp);/gu, (_, e) => ents[e])
    .replace(/\s+/gu, ' ').trim();
  if (!max || s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max / 2 ? cut.lastIndexOf(' ') : max)}…`;
}

// Who is reading, as far as the drawing cares. Nobody signed in is what a
// stranger sees, and what the server draws.
export const NOBODY = Object.freeze({
  account: false, pod: false, moderates: false, isNew: () => false,
  votedOn: () => 'none', isSaved: () => false, isJoined: () => false, mine: () => false,
});

// Where each public view is: under the forum's own path at its own host, and
// after `#` anywhere else.
export function addresses(root = null) {
  const part = (s) => encodeURIComponent(String(s));
  return {
    front: () => root || '#/',
    cat: (slug) => (root ? `${root}c/${part(slug)}` : `#/c/${slug}`),
    topic: (slug, tid, post = null) => (root
      ? `${root}t/${part(slug)}/${part(tid)}${post ? `#p-${post}` : ''}`
      : `#/t/${slug}/${tid}${post ? `/${post}` : ''}`),
  };
}

// --- the pieces a view is drawn from -------------------------------------
//
// `d` is what every piece needs besides its data: `viewer` (NOBODY or the
// reader's own), `addr` (addresses()), `handleOf(cat)` (the category's handle
// as this page names it) and `parse` (the cleaner's parser, where there is no
// browser to parse with).

// A post names the category it is for, and every reader of this page is
// already in it: the address is how it got here, not something to read.
export function body(p, cat, d) {
  const drop = cat ? (href, words) => href === cat.id
    || words.replace(/^@/u, '') === String(cat.slug || '') || words === d.handleOf(cat) : null;
  return d.parse ? cleanHtml(p?.content, d.parse, { drop }) : cleanHtml(p?.content, undefined, { drop });
}

// The author as they are known: their name when the forum kept a card for
// them, and always the handle, which is the thing that is theirs everywhere.
export function byline(p, author) {
  if (!author) return esc(p.author ? authorLabel(p.author) : '');
  const handle = esc(author.handle);
  const name = author.name && author.name !== author.handle ? esc(author.name) : null;
  const inner = name ? `${name} <span class="dim">${handle}</span>` : handle;
  // Their posts in this forum, not their page elsewhere: that is what a
  // reader here is asking for when they click a name.
  return `<a href="#/who/${encodeURIComponent(author.id)}">${inner}</a>`;
}

// Where this post can be READ away from here. A pod answers its post's own
// address with JSON, so that address is no use to a person and is not shown;
// a server that publishes a page for it says so, and the link names its host.
export function elsewhere(p) {
  if (!p?.page) return '';
  let host = '';
  try { host = new URL(p.page).host; } catch { return ''; }
  return ` <a href="${esc(p.page)}" class="dim" rel="noopener">on ${esc(host)}</a>`;
}

export function topicActs(topicId, d) {
  if (!d.viewer.moderates) return '';
  return `<div class="acts mod" role="group" aria-label="Moderator actions for this topic" data-topic="${esc(topicId)}">
    <button data-act="rename">Rename topic</button>
    <button data-act="unlock">Reopen topic</button>
    <button data-act="pin">Pin topic</button><button data-act="unpin">Unpin topic</button>
    <button data-act="sitepin">Pin site-wide</button><button data-act="siteunpin">Unpin site-wide</button>
    <button class="grave" data-act="lock">Close topic</button><button class="grave" data-act="droptopic">Delete topic</button>
  </div>`;
}

// Voting, both ways, as a forum has always had it: up, down, and the one you
// cast again to take it back. A reader with no account sees the counts.
export function votes(p, d) {
  const up = p.likes || 0;
  const down = p.dislikes || 0;
  // Signed out, the buttons are still buttons: pressing one asks who you are
  // and then casts the vote. Showing the counts as dead text hid the fact that
  // voting was possible at all.
  const mineWay = d.viewer.account ? d.viewer.votedOn(p.id) : 'none';
  const one = (way, mark, n, label) => `<button data-act="vote-${mineWay === way ? 'none' : way}"
    data-was="${mineWay}"${mineWay === way ? ' aria-pressed="true" class="voted"' : ''}
    aria-label="${mineWay === way ? `Take back your vote ${label}` : `Vote ${label} this post`}">${mark} ${n}</button>`;
  return one('up', '▲', up, 'for') + one('down', '▼', down, 'against');
}

// One post. A closed topic offers no Reply.
export function card(p, { author = null, cat = null, extra = '', waiting = false, anchor = null, closed = false } = {}, d) {
  const v = d.viewer;
  const at = p.published ? when(p.published) : '';
  // What a screen reader hears before the words, and what each of this post's
  // own buttons is called — a thread of them is not twenty identical "Reply"s.
  const whose = esc(author ? (author.name || author.handle) : (p.author ? authorLabel(p.author) : 'someone'));
  const named = `${waiting ? 'Waiting: p' : 'P'}ost by ${whose}${at ? `, ${esc(at)}` : ''}`;
  return `<article class="post${p.gone ? ' gone' : ''}${extra}" aria-label="${named}"${anchor ? ` id="p-${esc(anchor)}"` : ''}>
    <div class="who"><b>${waiting ? '<span class="dim">waiting for the forum · </span>' : ''}${byline(p, author)}</b>
      <span class="when">${esc(at)}${elsewhere(p)}</span></div>
    <div class="body">${p.gone ? 'This post was removed.' : (body(p, cat, d) || '<span class="dim">(not readable here)</span>')}</div>
    ${p.gone || waiting || !p.id ? '' : `<div class="acts" data-post="${esc(p.id)}">
      ${closed ? '' : `<button data-act="reply" aria-label="Reply to ${whose}">Reply</button>`}
      ${votes(p, d)}
      <button data-act="share" aria-label="Copy a link to the post by ${whose}">Share</button>
      ${v.account ? `<button data-act="${v.isSaved(p.id) ? 'unsave' : 'save'}" aria-label="${v.isSaved(p.id) ? 'Remove this post from your bookmarks' : 'Bookmark this post'}">${v.isSaved(p.id) ? 'Bookmarked' : 'Bookmark'}</button>` : ''}
      ${v.mine(p) || !v.account ? '' : `<button data-act="report" aria-label="Report the post by ${whose}">Report</button>`}
      ${v.mine(p) ? '<button data-act="edit" aria-label="Edit your own post">Edit</button><button data-act="delete" aria-label="Delete your own post">Delete</button>' : ''}
      ${!v.mine(p) && v.moderates ? `<button data-act="remove" aria-label="Remove the post by ${whose}">Remove</button>` : ''}
    </div>`}
  </article>`;
}

// A thread in the shape it was written: each reply under the post it answers,
// and anything whose parent is not here at the top level. Depth is capped so
// a long argument does not walk off the side of the page.
const MAX_DEPTH = 6;
export function threaded(posts, authors, cat, anchors, d, { closed = false } = {}) {
  const byId = new Map(posts.map(p => [p.id, p]));
  const kids = new Map();
  const roots = [];
  for (const p of posts) {
    const parent = p.inReplyTo && byId.has(p.inReplyTo) && p.inReplyTo !== p.id ? p.inReplyTo : null;
    if (!parent) { roots.push(p); continue; }
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(p);
  }
  const out = [];
  const walk = (p, depth) => {
    const html = card(p, { author: (p.author && authors[p.author]) || null, cat, anchor: anchors[p.id] || null, closed }, d);
    out.push(depth ? `<div class="nest" style="--depth:${Math.min(depth, MAX_DEPTH)}">${html}</div>` : html);
    for (const k of kids.get(p.id) || []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

// One stop is no trail: the front page needs no line saying it is the front page.
export function crumbs(parts) {
  if (parts.length < 2) return { html: '', hidden: true };
  return { hidden: false,
    html: parts.map(([label, href], i) => (href && i < parts.length - 1 ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label))).join(' › ') };
}

// The line naming who moderates, each name leading to their posts here.
export const modsWho = (names) => (names.length
  ? `<span class="lead">moderators:</span> ${names.map(n => `<a href="#/who/${encodeURIComponent(n.id)}">${esc(n.handle)}</a>`).join(', ')}`
  : '');

// What to call each moderator: the card the forum kept of them, then the
// actor's own word for it, and a name read off the address only when neither
// answers. `authorOf(catBase, id)` is the caller's, so a page asks once.
export function modNames(read, cats, ids, authorOf, at = 1) {
  const cat = cats[0];
  return inTurn(ids, at, async (id) => {
    const card = cat ? await authorOf(cat.base, id).catch(() => null) : null;
    return { id, handle: card?.handle || (await read.actorHandle(id).catch(() => null)) || authorLabel(id) };
  });
}

// --- the front page and a category ----------------------------------------

// What the front page reads: the forum's newest posts, and the pinned topics
// and the moderators of the forum and of every category. Kept whole, for
// every category, because which subset is on screen is the reader's business.
export async function readIndex(read, base, cats, want, at = 1) {
  const latest = await read.latest(base, { limit: want });
  const site = await read.featured(base);
  const pinned = {};
  const mods = {};
  await inTurn(cats, at, async (c) => {
    pinned[c.id] = await read.featured(c.base);
    mods[c.id] = await read.moderators(c.base);
  });
  return { at: Date.now(), limit: want, latest: [...latest], more: latest.more || 0, site, pinned, mods };
}

// Who moderates what is on screen: one category's own, or, showing the whole
// forum, whoever moderates any of them.
export function moderatorsOf(idx, here) {
  if (here) return idx.mods[here.id] || [];
  return [...new Set(Object.values(idx.mods).flat())];
}

// The rows the index shows: one per topic, the newest post in it standing
// for it, pinned topics first and then the column the reader chose.
export function frontRows({ cats, idx, filter = 'all', finding = '', order = 'date', down = true, shown = 30 }) {
  const here = cats.find(c => c.slug === filter) || null;
  const looking = finding.trim().toLowerCase();
  const mine = idx.latest.filter(p => (filter === 'all' || (cats.find(c => c.id === p.category)?.slug === filter))
    // Searching what the page has: a topic's name, an author's handle, and
    // the words of the post itself.
    && (!looking || [p.topicName, p.author, p.content].some(v => String(v || '').toLowerCase().includes(looking))));
  // A pin belongs to a category; the forum has a featured collection of its
  // own for a pin that holds everywhere.
  const pins = { cat: new Set(), site: new Set(idx.site) };
  for (const c of cats) {
    if (filter !== 'all' && c.slug !== filter) continue;
    for (const id of idx.pinned[c.id] || []) pins.cat.add(id);
  }
  const byTopic = new Map();
  for (const p of mine) {
    if (!p.topic) continue;
    const held = byTopic.get(p.topic);
    if (!held || String(p.published || '') > String(held.published || '')) byTopic.set(p.topic, p);
  }
  const rank = (p) => (pins.site.has(p.topic) ? 2 : pins.cat.has(p.topic) ? 1 : 0);
  // Posts, not replies: a topic with nobody answering yet still HAS the post
  // that started it. The count the forum keeps is of replies, so the opening
  // post is the one added here.
  const by = (p) => (order === 'replies' ? (p.topicReplies || 0) + 1 : String(p.published || ''));
  const topics = [...byTopic.values()].sort((a, b) => rank(b) - rank(a)
    || (down ? (by(a) > by(b) ? -1 : by(a) < by(b) ? 1 : 0) : (by(a) > by(b) ? 1 : by(a) < by(b) ? -1 : 0)));
  const page = topics.slice(0, shown);
  return { here, pins, topics, page, more: Math.max(0, topics.length - page.length) + (idx.more || 0) };
}

// Who wrote each row, and the digest its link carries.
export function rowFacts(page, cats, authorOf, digestOf = cacheKey) {
  return Promise.all(page.map(async (p) => {
    const cat = cats.find(c => c.id === p.category) || null;
    return { cat, who: cat && p.author ? await authorOf(cat.base, p.author) : null, digest: await digestOf(p.id) };
  }));
}

// The categories line, and the search and new-topic controls at the end of
// the moderators line.
export function frontChips({ cats, filter, here }, d) {
  const v = d.viewer;
  const chip = (slug, label) => `<a class="chip${filter === slug ? ' on' : ''}"${filter === slug ? ' aria-current="page"' : ''} href="${esc(slug === 'all' ? d.addr.front() : d.addr.cat(slug))}">${esc(label)}</a>`;
  return `<p class="hint chips">Categories: ${chip('all', 'All')}${cats.map(c => chip(c.slug || '', c.name)).join('')}
    ${v.account ? '<a class="chip" href="#/replies">Replies to you</a><a class="chip" href="#/bookmarks">Bookmarked</a>' : ''}
    ${v.moderates ? '<a class="chip" href="#/queue">Queue</a><a class="chip" href="#/settings">Settings</a>' : ''}
    <span class="rowend">
      ${here && v.account && v.pod ? `<button class="new" data-act="${v.isJoined(here.id) ? 'leave' : 'join'}" data-cat="${esc(here.id)}">${v.isJoined(here.id) ? 'Leave' : 'Join'}</button>` : ''}
    </span></p>`;
}
export function frontActs({ cats, filter, finding = '' }) {
  // Starting a topic from the front page: in the category being shown, or the
  // first one when the whole forum is.
  const into = cats.find(c => c.slug === filter) || cats[0] || null;
  return `<label class="vh" for="find">Search this forum</label>
    <input type="text" id="find" placeholder="Search" value="${esc(finding)}" autocomplete="off"${finding ? '' : ' hidden'}>
    <button data-act="search"${finding ? ' hidden' : ''}>Search</button>
    ${into ? `<button data-act="newtopic" data-slug="${esc(into.slug || '')}">New topic</button>` : ''}`;
}

// The front page or a category, drawn: `rows` from frontRows, `facts` from
// rowFacts, `membersOnly` when a category that lists nothing will not answer
// this reader. Returns the parts of the page and what is said aloud.
export function drawFront({ forum, cats, filter, finding = '', order = 'date', down = true, rows, facts = [], membersOnly = false, front }, d) {
  const { here, pins, page, more } = rows;
  const head = frontChips({ cats, filter, here }, d);
  const out = {
    crumbs: crumbs(here ? [['Home', d.addr.front()], [here.name, d.addr.cat(here.slug)]] : [['Home', d.addr.front()]]),
    acts: frontActs({ cats, filter, finding }),
    title: here ? here.name : (forum.name || 'FediPod-BB'),
    description: plainText(here ? here.summary : forum.summary, 200),
    fresh: 0,
  };
  if (!rows.topics.length) {
    // A members-only category that will not answer this reader looks exactly
    // like an empty one, which is why the caller asked it.
    if (here && membersOnly) {
      return { ...out, say: 'This category is for its members',
        main: head + (d.viewer.pod
          ? `<p class="empty row">This category is for its members.
           <button class="new" data-act="ask-join" data-cat="${esc(here.id)}">Request membership</button></p>`
          : `<p class="empty row">This category is for its members, and membership needs a FediPod account.
           <a class="big" href="${esc(front)}/new-account">Get a FediPod account</a></p>`) };
    }
    // The one thing to do on an empty page is the one thing offered.
    return { ...out, say: 'Nothing posted here yet',
      main: head + '<p class="empty">Nothing posted here yet. Use the button at the upper right to create a topic.</p>' };
  }
  const tr = [];
  for (let i = 0; i < page.length; i++) {
    const p = page[i];
    const { cat, who, digest } = facts[i] || {};
    const tid = p.topic ? p.topic.split('/').pop() : null;
    const href = cat && tid ? d.addr.topic(cat.slug, tid, digest) : null;
    const name = esc(p.topicName || 'Topic');
    // New to THIS reader: posted since they last had the topic open.
    const isNew = d.viewer.isNew(p.topic, p.published);
    if (isNew) out.fresh += 1;
    const by = who ? who.handle : (p.author ? authorLabel(p.author) : '');
    tr.push(`<tr>
      <td>${pins.site.has(p.topic) ? '<span class="pin" title="Pinned across the forum" role="img" aria-label="pinned across the forum">⭐</span> ' : pins.cat.has(p.topic) ? '<span class="pin" title="Pinned in this category" role="img" aria-label="pinned in this category">📌</span> ' : ''}${href ? `<a href="${esc(href)}">${name}</a>` : name}${isNew
        ? ' <span class="badge">New<span class="vh"> since you last opened this topic</span></span>' : ''}</td>
      <td>${cat ? esc(cat.name) : ''}</td>
      <td>${by ? (p.author
        ? `<a class="who" href="#/who/${encodeURIComponent(p.author)}" title="${esc(by)}">${esc(by)}</a>`
        : `<span class="who" title="${esc(by)}">${esc(by)}</span>`) : ''}</td>
      <td>${esc(when(p.published))}</td>
      <td>${Number.isFinite(p.topicReplies) ? p.topicReplies + 1 : ''}</td>
    </tr>`);
  }
  // A table, so a reader can run their eye down any one of the four things
  // an entry says.
  out.main = head + `<div class="scroll" role="region" aria-label="Topics, most recently posted in first" tabindex="0"><table class="index">
    <thead><tr><th scope="col">Topic</th><th scope="col">Category</th><th scope="col">Latest by</th>
      <th scope="col" aria-sort="${order === 'date' ? (down ? 'descending' : 'ascending') : 'none'}">
        <button class="sort" data-act="order" data-order="date">Date ${order === 'date' ? (down ? '▼' : '▲') : '<span class="dim">▽</span>'}</button></th>
      <th scope="col" aria-sort="${order === 'replies' ? (down ? 'descending' : 'ascending') : 'none'}">
        <button class="sort" data-act="order" data-order="replies">Posts ${order === 'replies' ? (down ? '▼' : '▲') : '<span class="dim">▽</span>'}</button></th></tr></thead>
    <tbody>${tr.join('')}</tbody></table>
    ${more ? `<p class="row"><button data-act="more">Show ${Math.min(more, 30)} more of ${more}</button></p>` : ''}</div>`;
  out.say = `${tr.length} topic${tr.length === 1 ? '' : 's'}${out.fresh ? `, ${out.fresh} with something new` : ''}`;
  return out;
}

// --- a topic ---------------------------------------------------------------

// What a topic reads: its head and every post's readable copy, each author's
// card, the anchor each post is linked by, and who moderates its category.
export async function readTopic(read, cat, tid, at = 1) {
  const topicId = cat.base + 'ap/topic/' + tid;
  const moderators = await read.moderators(cat.base);
  const t = await read.topic(topicId);
  if (!t) return { topicId, t: null, moderators };
  const copies = await inTurn(t.posts, at, (id) => read.post(cat.base, id));
  const posts = t.posts.map((id, i) => ({ id, ...(copies[i] || {}) }));
  const who = [...new Set(posts.map(p => p.author).filter(Boolean))];
  const cards = await inTurn(who, at, (a) => read.author(cat.base, a));
  const authors = Object.fromEntries(who.map((a, i) => [a, cards[i]]));
  const keys = await Promise.all(posts.map(p => cacheKey(p.id)));
  const anchors = Object.fromEntries(posts.map((p, i) => [p.id, keys[i]]));
  return { topicId, t, posts, authors, anchors, moderators };
}

// A topic, drawn. `pending` are this reader's own posts not yet placed, as
// posts. A closed topic takes nothing more, so the page does not offer it.
export function drawTopic({ cat, slug, topicId, t, posts = [], authors = {}, anchors = {}, pending = [] }, d) {
  if (!t) {
    return { crumbs: crumbs([['Home', d.addr.front()], [cat.name, d.addr.cat(slug)], ['topic', null]]),
      main: '<p class="err">No such topic.</p>', say: 'No such topic', title: cat.name, description: '' };
  }
  const closed = !!t.closed;
  return {
    crumbs: crumbs([['Home', d.addr.front()], [cat.name, d.addr.cat(slug)], [t.name, null]]),
    title: t.name || cat.name,
    description: plainText(body(posts.find(p => !p.gone) || {}, cat, d), 200),
    say: `${t.name}, ${posts.length} post${posts.length === 1 ? '' : 's'}`,
    main: `<div class="topline"><h1>${esc(t.name)}</h1>
      ${closed ? '' : `<button class="primary" data-act="newpost" data-topic="${esc(topicId)}">New post</button>`}</div>
    ${closed ? '<p class="hint">This topic is closed. No more replies are being taken.</p>' : ''}
    ${topicActs(topicId, d)}

    ${threaded(posts, authors, cat, anchors, d, { closed }).join('')}
    ${pending.map(w => card(w, { cat, extra: ' waiting', waiting: true }, d)).join('')}`,
  };
}
