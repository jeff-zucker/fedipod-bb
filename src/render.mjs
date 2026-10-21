// render.mjs — a forum's page at its own host, drawn on the server: the
// front page, a category or a topic, read as a stranger reads it and drawn
// with the page's own drawing, with what it was drawn from in the page so the
// browser reads none of it again. Anything that does not come out whole is
// nothing, and the caller sends the page undrawn for the browser to build.

import { parseDocument } from 'htmlparser2';
import { reader, placeOf, viewOfPath } from '../site/read.mjs';
import { NOBODY, addresses, esc, modNames, modsWho, readIndex, frontRows, rowFacts, moderatorsOf,
  drawFront, readTopic, drawTopic } from '../site/draw.mjs';

// The page cleans a post with the browser's parser; here htmlparser2's tree
// stands in, read through the same few DOM properties the cleaner uses.
const node = (n) => (n.type === 'text' ? { nodeType: 3, nodeValue: n.data }
  : ['tag', 'script', 'style'].includes(n.type)
    ? { nodeType: 1, nodeName: n.name.toUpperCase(),
        attributes: Object.entries(n.attribs).map(([name, value]) => ({ name, value })),
        get childNodes() { return n.children.map(node); } }
    : { nodeType: 8 });
export const parse = (html) => ({ childNodes: parseDocument(html).children.map(node) });

// How many documents are asked for at once, and how long a reader waits for
// the drawing before the page goes out undrawn instead.
const AT = 8;
const DEADLINE_MS = 2000;
// Enough posts to fill a page of topics, as the page asks for.
const FRONT_POSTS = 150;

// The page with the drawing in place of its empty parts. Every part it fills
// must be where it was, or the page is not drawn at all.
function fill(shell, { title, description, forumName, forumHref, modsLine, acts, trail, main, data }) {
  const swaps = [
    [/<title>[^<]*<\/title>/u, `<title>${esc(title)}</title>${description ? `\n<meta name="description" content="${esc(description)}">` : ''}`],
    [/<a id="forum-link" href="[^"]*">[^<]*<\/a>/u, `<a id="forum-link" href="${esc(forumHref)}">${esc(forumName)}</a>`],
    [/<span id="mods-who"><\/span>/u, `<span id="mods-who">${modsLine}</span>`],
    [/<span id="mods-acts"><\/span>/u, `<span id="mods-acts">${acts}</span>`],
    [/<nav class="crumbs" id="crumbs" aria-label="Breadcrumb"><\/nav>/u,
      `<nav class="crumbs" id="crumbs" aria-label="Breadcrumb"${trail.hidden ? ' hidden' : ''}>${trail.html}</nav>`],
    [/<main id="main" tabindex="-1">[\s\S]*?<\/main>/u, `<main id="main" tabindex="-1">\n${main}\n</main>`],
    // What it was drawn from, for the page: JSON, with nothing in it that can
    // end the element it sits in.
    [/<script type="module"/u, `<script type="application/json" id="bb-data">${JSON.stringify(data).replace(/</gu, '\\u003c')}</script>\n<script type="module"`],
  ];
  let out = shell;
  for (const [at, to] of swaps) {
    if (!at.test(out)) return null;
    out = out.replace(at, () => to);
  }
  return out;
}

async function draw(url, shell, f) {
  const place = placeOf({ origin: url.origin, pathname: url.pathname, search: '' });
  if (!place.own || !place.root || !place.base) return null;
  const view = viewOfPath(url.pathname, place.root);
  const read = reader({ fetch: f, at: AT });
  const forum = await read.forum(place.base);
  if (!forum) return null;
  const cats = forum.categories;
  const addr = addresses(place.root);
  const frontHost = new URL(place.front).host;
  const handleOf = (cat) => (cat.slug ? `@${cat.slug}@${frontHost}` : cat.id);
  const d = { viewer: NOBODY, addr, handleOf, parse };
  const cards = new Map();
  const authorOf = (cbase, id) => {
    const key = `${cbase}|${id}`;
    if (!cards.has(key)) cards.set(key, read.author(cbase, id).catch(() => null));
    return cards.get(key);
  };
  // The edge keeps the page under the forum's and every category's names,
  // the same names their documents carry, so what drops those drops this.
  const tags = [`u-${place.handle}`, ...cats.map(c => c.slug).filter(Boolean).map(s => `u-${s}`)];
  const data = { v: 1, view, forum };
  let drawn;
  let status = 200;
  let names;
  if (view.kind === 'topic') {
    const cat = cats.find(c => c.slug === view.slug || c.base.endsWith('/c/' + view.slug + '/'));
    if (!cat) {
      status = 404;
      drawn = { main: '<p class="err">No such category.</p>', crumbs: { html: '', hidden: true }, title: forum.name || 'FediPod-BB', description: '', acts: '' };
    } else {
      const got = await readTopic(read, cat, view.tid, AT);
      if (!got.t) status = 404;
      drawn = { acts: '', ...drawTopic({ cat, slug: view.slug, ...got }, d) };
      data.topic = got;
    }
    // A topic shows who runs the forum, as the page does when it opens there.
    names = (forum.admins || []).map(a => ({ id: a.id, handle: a.handle }));
  } else {
    const filter = view.kind === 'cat' ? view.slug : 'all';
    const idx = await readIndex(read, place.base, cats, FRONT_POSTS, AT);
    const rows = frontRows({ cats, idx, filter });
    const facts = await rowFacts(rows.page, cats, authorOf);
    let membersOnly = false;
    if (!rows.topics.length && rows.here) membersOnly = !(await read.topics(rows.here.base)).total && !(await read.canRead(rows.here.base));
    if (view.kind === 'cat' && !rows.here) status = 404;
    drawn = drawFront({ forum, cats, filter, rows, facts, membersOnly, front: place.front }, d);
    const mods = moderatorsOf(idx, rows.here);
    names = mods.length ? await modNames(read, cats, mods, authorOf, AT) : (forum.admins || []).map(a => ({ id: a.id, handle: a.handle }));
    data.index = idx;
    data.facts = { authors: Object.fromEntries(await Promise.all([...cards].map(async ([k, p]) => [k, await p]))),
      digests: Object.fromEntries(rows.page.map((p, i) => [p.id, facts[i].digest])) };
  }
  data.names = names;
  const html = fill(shell, {
    title: drawn.title, description: drawn.description, forumName: forum.name || 'Forum', forumHref: addr.front(),
    modsLine: modsWho(names), acts: drawn.acts || '', trail: drawn.crumbs, main: drawn.main, data,
  });
  return html ? { status, html, tags } : null;
}

/**
 * The page for `url` at a forum's own host (`https://bb.<gateway>/<forum>/…`),
 * drawn from `shell` (the page as the site serves it), reading the forum
 * through `fetch`. Returns { status, html, tags } or null: null means send
 * the page undrawn. Never throws. A drawing that is not done in time goes on
 * reading after the page has gone, when `keepGoing(promise)` lets it (the
 * host's waitUntil): what it reads is then at hand for the next reader.
 */
export async function renderPage({ url, shell, fetch: f = globalThis.fetch.bind(globalThis), deadlineMs = DEADLINE_MS, keepGoing = null }) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.search || !shell) return null;
  const work = draw(u, shell, f).catch(() => null);
  let timer;
  const LATE = Symbol('late');
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(LATE), deadlineMs); });
  try {
    const out = await Promise.race([work, late]);
    if (out !== LATE) return out;
    try { keepGoing?.(work); } catch { /* the host would not wait */ }
    return null;
  } finally { clearTimeout(timer); }
}
