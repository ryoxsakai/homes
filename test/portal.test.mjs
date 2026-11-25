import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appShell, isPortalPath, portalResponse } from '../worker/portal.mjs';

const requested = [];
const assets = { async fetch(request) {
  const path = new URL(request.url).pathname;
  requested.push(path);
  if (path === '/todo/') return new Response('private-html', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (path === '/shared/header.js') return new Response('private-script', { headers: { 'Content-Type': 'text/javascript' } });
  return new Response('missing', { status: 404 });
} };
const render = (status, body, options) => ({ status, body, options });
function get(path, member, method = 'GET') {
  const url = new URL(path, 'https://homes.example.test');
  return portalResponse(new Request(url, { method }), url, member, assets, render);
}
const member = { alias: '家族A' };

test('signed-out visitors are sent to sign-in and never reach any Works-derived file', async () => {
  requested.length = 0;
  for (const path of ['/app', '/todo/', '/memo/', '/todo', '/books/', '/books']) assert.deepEqual(await get(path, null), { status: 303, body: null, options: { location: '/' } });
  assert.equal((await get('/shared/header.js', null)).status, 404);
  assert.equal((await get('/todo/todo.js', null)).status, 404);
  assert.equal((await get('/books/vendor/zxing-library-0.21.3.min.js', null)).status, 404);
  assert.equal(requested.length, 0);
  assert.equal(isPortalPath('/worker/data.mjs'), false);
  assert.equal(isPortalPath('/test/data.test.mjs'), false);
});

test('signed-in pages get the self-only script CSP that still allows the mobile service frames', async () => {
  const page = await get('/todo/', member);
  assert.equal(page.status, 200);
  assert.equal(page.options.referrer, 'same-origin');
  assert.match(page.options.csp, /script-src 'self';/);
  assert.doesNotMatch(page.options.csp, /script-src[^;]*unsafe/);
  assert.match(page.options.csp, /connect-src 'self'/);
  assert.match(page.options.csp, /frame-ancestors 'self'/);
  assert.match(page.options.csp, /frame-src 'self'/);
  const script = await get('/shared/header.js?v=1', member);
  assert.equal(script.options.type, 'text/javascript');
  assert.equal(script.options.csp, undefined);
  assert.equal((await get('/todo/missing.js', member)).status, 404);
  assert.equal((await get('/todo/', member, 'POST')).status, 405);
  assert.deepEqual(await get('/memo', member), { status: 308, body: null, options: { location: '/memo/' } });
  assert.deepEqual(await get('/books', member), { status: 308, body: null, options: { location: '/books/' } });
});

test('the app entry resumes the last service and advertises the Homes install metadata', async () => {
  const app = await get('/app', member);
  assert.equal(app.body, appShell);
  assert.match(appShell, /<script type="module" src="\/shared\/app-entry\.mjs"><\/script>/);
  assert.match(appShell, /rel="apple-touch-icon" sizes="600x600" href="\/homes-icon\.png"/);
  assert.match(appShell, /apple-mobile-web-app-title" content="Homes"/);
  assert.equal((await get('/app?x=1', member)).options.location, '/app');
});
