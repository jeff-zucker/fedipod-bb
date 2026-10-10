// clean.test.mjs — a post's text, as stored and as shown: one copy when a
// server sends it once per language, and only the markup a post may carry.
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'htmlparser2';
import { cleanHtml, textOf } from '../site/read.mjs';
import * as publish from '../src/publish.mjs';

// The page parses with DOMParser; here htmlparser2 stands in, read through
// the same few DOM properties the cleaner uses.
const node = (n) => (n.type === 'text' ? { nodeType: 3, nodeValue: n.data }
  : ['tag', 'script', 'style'].includes(n.type)
    ? { nodeType: 1, nodeName: n.name.toUpperCase(),
        attributes: Object.entries(n.attribs).map(([name, value]) => ({ name, value })),
        get childNodes() { return n.children.map(node); } }
    : { nodeType: 8 });
const parse = (html) => ({ childNodes: parseDocument(html).children.map(node) });

const hostile = '<p>Hello <strong>Rahel</strong></p>'
  + '<img src="https://tracker.example/x.png">'
  + '<a href="https://elsewhere.example/" style="position:fixed;inset:0">Sign in again</a>'
  + '<a href="javascript:alert(1)">x</a><script>alert(1)</script><style>body{display:none}</style>'
  + '<button>Delete</button><span class="mention" onclick="alert(1)">@deniz</span>';

test('a post is shown with only the markup a post may carry', () => {
  const out = cleanHtml(hostile, parse);
  assert.equal(out, '<p>Hello <strong>Rahel</strong></p>'
    + '<a href="https://elsewhere.example/" rel="nofollow noopener noreferrer">Sign in again</a>'
    + '<a rel="nofollow noopener noreferrer">x</a>'
    + 'Delete<span class="mention">@deniz</span>');
});

test('text that looks like markup is shown as text', () => {
  assert.equal(cleanHtml('<p>1 &lt; 2 &amp; "so"</p>', parse), '<p>1 &lt; 2 &amp; &quot;so&quot;</p>');
});

test('a post sent once per language shows one copy', () => {
  assert.equal(textOf(['<p>Hello</p>', '<p>Hello</p>']), '<p>Hello</p>');
  assert.equal(textOf('<p>Hello</p>'), '<p>Hello</p>');
  assert.equal(textOf(undefined), '');
  assert.equal(cleanHtml(['<p>Hello</p>', '<p>Hello</p>'], parse), '<p>Hello</p>');
});

test('the forum stores one cleaned copy of a post sent once per language', async () => {
  const docs = new Map();
  const remote = { putJson: async (u, o) => { docs.set(u, o); return { ok: true }; } };
  const urls = { cached: (id) => 'https://forum.example/ap/cache/' + encodeURIComponent(id) };
  const url = await publish.cachePost({ remote, urls },
    { id: 'https://social.example/users/sipho/statuses/1', type: 'Note', content: [hostile, hostile] });
  const content = docs.get(url).content;
  assert.equal(typeof content, 'string');
  assert.ok(!/<img|<script|style=|javascript:/u.test(content), content);
  assert.ok(content.startsWith('<p>Hello <strong>Rahel</strong></p>'));
});
