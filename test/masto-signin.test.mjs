// masto-signin.test.mjs — signing in to the forum with a Mastodon account,
// both legs as the page runs them: the reader leaves from the forum's
// address, and the page loads again at the address Mastodon sends them back
// to. The Mastodon here refuses what Mastodon refuses: a key is handed out
// only to the app the code was issued to, for the address it approved.
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { MastoLogin, returnAddress } from '../site/masto.mjs';

function strictMastodon() {
  const apps = new Map();     // client_id -> { secret, redirect }
  const codes = new Map();    // code -> { clientId, redirect }
  let n = 0;
  const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.endsWith('/api/v1/apps')) {
      const id = `cid-${++n}`;
      apps.set(id, { secret: `sec-${n}`, redirect: body.redirect_uris });
      return j({ client_id: id, client_secret: `sec-${n}` });
    }
    if (url.endsWith('/oauth/token')) {
      const issued = codes.get(body.code);
      const app = apps.get(body.client_id);
      if (!issued || !app || app.secret !== body.client_secret || issued.clientId !== body.client_id
        || issued.redirect !== body.redirect_uri) {
        return j({ error: 'invalid_grant', error_description: 'The provided authorization grant is invalid.' }, 400);
      }
      codes.delete(body.code);
      return j({ access_token: 'tok', scope: body.scope });
    }
    if (url.endsWith('/api/v1/accounts/verify_credentials')) {
      return init.headers?.authorization === 'Bearer tok' ? j({ username: 'jiwoo', display_name: 'Ji-woo' }) : j({ error: 'no' }, 401);
    }
    return j({ error: 'no' }, 404);
  };
  // The reader presses Authorize: the browser lands on the approved address
  // with the code and the state added, as Mastodon sends it.
  const approve = (authorizeUrl) => {
    const u = new URL(authorizeUrl);
    const clientId = u.searchParams.get('client_id');
    const redirect = u.searchParams.get('redirect_uri');
    if (apps.get(clientId)?.redirect !== redirect) throw new Error('Mastodon refuses an address the app did not register');
    const code = `code-${++n}`;
    codes.set(code, { clientId, redirect });
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    back.searchParams.set('state', u.searchParams.get('state'));
    return back.href;
  };
  return { fetch, approve };
}

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

for (const page of ['https://bb.fedipod.net/forum/', 'https://fedipod.net/bb/?forum=forum',
  'https://bb.fedipod.net/?pod=https://fp3.solidcommunity.net/fedipod-bb/']) {
  test(`a Mastodon sign-in started at ${page} is finished when the page comes back`, async () => {
    const masto = strictMastodon();
    const storage = memory();
    const leaving = new MastoLogin({ fetch: masto.fetch, storage, redirectUri: returnAddress(page) });
    const landed = masto.approve(await leaving.begin('mastodon.example'));
    // The page loads again at the address it was sent back to.
    const back = new MastoLogin({ fetch: masto.fetch, storage, redirectUri: returnAddress(landed) });
    const q = new URL(landed).searchParams;
    const acct = await back.complete({ state: q.get('state'), code: q.get('code') });
    assert.equal(acct.handle, '@jiwoo@mastodon.example');
    assert.equal(back.account().token, 'tok');
  });
}

test('the page coming back at its full address, code and state included, is refused, as Mastodon refuses it', async () => {
  const masto = strictMastodon();
  const storage = memory();
  const page = 'https://bb.fedipod.net/forum/';
  const leaving = new MastoLogin({ fetch: masto.fetch, storage, redirectUri: page });
  const landed = masto.approve(await leaving.begin('mastodon.example'));
  const u = new URL(landed);
  const back = new MastoLogin({ fetch: masto.fetch, storage, redirectUri: u.origin + u.pathname + u.search });
  await assert.rejects(back.complete({ state: u.searchParams.get('state'), code: u.searchParams.get('code') }), /grant is invalid/u);
});
