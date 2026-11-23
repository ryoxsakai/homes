import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPortalPath, portalResponse } from '../worker/portal.mjs';
const portal = { html: 'private-html', css: 'private-style', js: 'private-script' };
const render = (status, body, options) => ({ status, body, options });
function get(path, session, method = 'GET') {
  const url = new URL(path, 'https://homes.example.test');
  return portalResponse(new Request(url, { method }), url, session, portal, render);
}

test('portal redirects unauthenticated document navigation and hides every asset', () => {
  assert.deepEqual(get('/app', null), { status:303, body:null, options:{ location:'/' } });
  assert.equal(get('/assets/homes-app.css', null).status, 404);
  assert.equal(get('/assets/homes-app.mjs', null).status, 404);
  assert.equal(isPortalPath('/worker/ui/app.html'), false);
});

test('clean signed-in shell has self-only CSP and same-origin form referrer', () => {
  const session = { sub: 'synthetic-test' };
  const app = get('/app', session);
  assert.equal(app.status, 200);
  assert.equal(app.body, portal.html);
  assert.equal(app.options.referrer, 'same-origin');
  assert.match(app.options.csp, /script-src 'self'/);
  assert.match(app.options.csp, /frame-ancestors 'none'/);
  assert.match(app.options.csp, /form-action 'self'/);
  assert.equal(get('/assets/homes-app.css', session).options.type, 'text/css; charset=utf-8');
  assert.equal(get('/assets/homes-app.mjs', session).options.type, 'text/javascript; charset=utf-8');
  assert.equal(get('/app', session, 'POST').status, 405);
  assert.equal(get('/app?ignored=query', session).options.location, '/app');
});
