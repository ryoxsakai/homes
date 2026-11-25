import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from "node:crypto";
import assert from 'node:assert/strict';
import { createApp } from '../worker/auth.mjs';

const origin = 'https://homes.example.test';
const env = {HOMES_AUTH_ORIGIN: origin, GOOGLE_CLIENT_ID:'fake', GOOGLE_CLIENT_SECRET:'fake',
  HOMES_OWNER_EMAIL:'synthetic@gmail.com', AUTH_STORE:{idFromName(){ return 'auth'; },get() { return {readSession: async () => ({email:'synthetic@gmail.com', sub:'synthetic'})}; }}};
const bytes = async (file) => readFile(new URL('../worker/ui/' + file, import.meta.url));

test('installing from the login page and the signed-in app uses one standalone app on the auth origin', async () => {
  const icon = await bytes('Homes.png');
  const app = createApp({installIcon: icon, assets:{fetch: async () => new Response('private', {headers:{'Content-Type':'text/html'}})}});
  const get = (path, headers) => app.fetch(new Request(origin + path, {headers}), env);
  const headers = {cookie:'__Host-homes-session=' + 'a'.repeat(43)};
  const anonymous = await get('/');
  const signedIn = await get('/app', headers);
  for (const reply of [anonymous, signedIn]) {
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-security-policy'), /manifest-src 'self'/);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    const html = await reply.text();
    assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
    assert.match(html, /rel="manifest" href="\/homes\.webmanifest"/);
    assert.match(html, /rel="apple-touch-icon" sizes="600x600" href="\/homes-icon\.png"/);
  }
  const m = await get('/homes.webmanifest');
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /^application\/manifest\+json/);
  assert.equal(m.headers.get('set-cookie'), null);
  const manifest = await m.json();
  assert.deepEqual([manifest.id, manifest.start_url, manifest.scope, manifest.display], ['/', '/', '/', 'standalone']);
  assert.equal(new URL(manifest.start_url, m.url || origin).origin, origin);
  assert.equal((await get(manifest.start_url, headers)).headers.get('location'), '/app');
  const i = await get(manifest.icons[0].src);
  assert.equal(i.headers.get('content-type'), 'image/png');
  assert.equal(i.headers.get('set-cookie'), null);
  assert.deepEqual(Buffer.from(await i.arrayBuffer()), icon);
  assert.equal(icon.readUInt32BE(16), 600);
  assert.equal(icon.readUInt32BE(20), 600);
});

test('public install assets do not access either database or open any private routes', async () => {
  const app = createApp({installIcon: new Uint8Array([1])});
  const offOrigin = 'https://wrong.example.test';
  const e = {...env, AUTH_STORE:new Proxy({}, {get(){ throw Error('unexpected DB access'); }})};
  const get = (path, method = 'GET', host = origin) => app.fetch(new Request(host + path, {method}), e);
  for (const path of ['/homes.webmanifest', '/homes-icon.png']) {
    assert.equal((await get(path + '?cache-test=1')).status, 200);
    assert.equal((await get(path, 'POST')).status, 405);
    assert.equal((await get(path, 'GET', offOrigin)).status, 404);
  }
  assert.equal((await get('/api/me')).status, 401);
  assert.equal((await get('/app')).headers.get('location'), '/');
  assert.equal((await get('/shared/header.js')).status, 404);
  assert.equal((await get('/todo/')).headers.get('location'), '/');
  assert.equal((await get('/worker/ui/Homes.png')).status, 404);
  assert.equal((await get('/service-worker.js')).status, 404);
});

test('public sign-in preserves the OAuth link and authorizes only its pinned stylesheet', async () => {
  const app = createApp();
  const get = path => app.fetch(new Request(origin + path), env);
  const home = await get('/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /href="\/auth\/start"/);
  assert.match(html, /Googleでログイン/);
  assert.match(html, /alt=""[^>]*><span>Homes<\/span>/);
  assert.doesNotMatch(html, /<script|<iframe|https?:\/\//i);
  const csp = home.headers.get('Content-Security-Policy');
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.ok(csp.includes("style-src 'sha256-" + createHash('sha256').update(style).digest('base64') + "'"));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(home.headers.get('Referrer-Policy'), 'no-referrer');
  const error = await get('/auth/callback');
  assert.equal(error.status, 400);
  assert.match(await error.text(), /Homesに戻る/);
});
