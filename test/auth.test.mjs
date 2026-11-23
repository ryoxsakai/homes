import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createApp, readGoogleIdentity } from '../worker/auth.mjs';

const origin = 'https://homes.example.test';
const cookie = (response, prefix) => response.headers.getSetCookie().map(x => x.split(';')[0]).find(x => x.startsWith(prefix));
const stateCookie = '__Host-homes-state=';
const sidCookie = '__Host-homes-session=';
function fixture({ email = 'owner@gmail.com', sub = 'account1' } = {}) {
  const attempts = new Map(), sessions = new Map();
  const store = {
    putState: async (k,n,v) => attempts.set(k,{nonce:n,verifier:v}),
    takeState: async k => { const a = attempts.get(k); attempts.delete(k); return a; },
    replaceSession: async (key,email,sub,old) => { sessions.delete(old); sessions.set(key,{email,sub}); },
    readSession: async k => sessions.get(k),
    removeSession: async k => sessions.delete(k)
  };
  const env = { HOMES_AUTH_ORIGIN:origin, HOMES_OWNER_EMAIL:'owner@gmail.com', GOOGLE_CLIENT_ID:'test-client', GOOGLE_CLIENT_SECRET:'test-secret', AUTH_STORE:{ idFromName: () => 'store', get: () => store } };
  let exchanges = 0;
  const app = createApp({
    upstream: async (url, init) => {
      ++exchanges;
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(init.redirect, 'error');
      assert.equal(init.body.get('redirect_uri'), origin + '/auth/callback');
      assert.match(init.body.get('code_verifier'), /^[\w-]{43}$/);
      return Response.json({id_token:'test-id'});
    },
    verify: async (id, aud, nonce) => {
      assert.equal(id, 'test-id');
      assert.equal(aud, env.GOOGLE_CLIENT_ID);
      assert.match(nonce, /^[\w-]{43}$/);
      return {email,sub};
    }
  });
  const call = (path, init) => app.fetch(new Request(origin + path, init), env);
  const start = async () => {
    const r = await call('/auth/start');
    assert.equal(r.status,303);
    const u = new URL(r.headers.get('Location'));
    assert.equal(u.origin,'https://accounts.google.com');
    assert.equal(u.searchParams.get('scope'),'openid email');
    assert.equal(u.searchParams.get('code_challenge_method'),'S256');
    const s = u.searchParams.get('state');
    return {path:'/auth/callback?state='+s+'&code=fake', headers:{Cookie:cookie(r,stateCookie)}, r};
  };
  return {call, start, env, app, attempts, sessions, exchanges: () => exchanges};
}

test('successful sign-in sets secure host-only state and session cookies; releases no tokens', async () => {
  const f = fixture(), s = await f.start();
  assert.match(s.r.headers.getSetCookie()[0], /Path=\/; Secure; HttpOnly; SameSite=Lax/);
  const r = await f.call(s.path,{headers:s.headers});
  assert.equal(r.status,303);
  assert.equal(r.headers.get('Location'),'/');
  assert.equal(r.headers.get('Cache-Control'),'no-store');
  assert.match(r.headers.getSetCookie().find(x=>x.startsWith(sidCookie)), /Max-Age=28800; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  const headers = {Cookie:cookie(r,sidCookie)};
  const home = await (await f.call('/',{headers})).text();
  assert.match(home,/ログイン済み/);
  assert.doesNotMatch(home,/owner@gmail|test-id/);
});

test('missing, incorrect, duplicate, expired, canceled or replayed state is rejected', async () => {
  const f = fixture(), s = await f.start();
  assert.equal((await f.call(s.path)).status,400);
  assert.equal((await f.call(s.path,{headers:{Cookie:s.headers.Cookie+'; '+s.headers.Cookie}})).status,400);
  assert.equal((await f.call(s.path+'&state=extra',{headers:s.headers})).status,400);
  assert.equal((await f.call(s.path+'&error=access_denied',{headers:s.headers})).status,400);
  assert.equal((await f.call(s.path,{headers:s.headers})).status,400);
  const expired = await f.start(); f.attempts.clear();
  assert.equal((await f.call(expired.path,{headers:expired.headers})).status,400);
  assert.equal(f.exchanges(),0);
});

test('reject disallowed identity; recheck current allowlist for active sessions', async () => {
  const other = fixture({email:'other@gmail.com'}), s = await other.start();
  const rejected = await other.call(s.path,{headers:s.headers});
  assert.equal(rejected.status,403);
  assert.equal(cookie(rejected,sidCookie),undefined);
  const f = fixture(), a = await f.start();
  const r = await f.call(a.path,{headers:a.headers});
  f.env.HOMES_OWNER_EMAIL = 'another@gmail.com';
  assert.doesNotMatch(await (await f.call('/',{headers:{Cookie:cookie(r,sidCookie)}})).text(), /ログイン済み/);
});

test('tampered or expired session, cross-origin logout and logged-out replay', async () => {
  const f = fixture(), s = await f.start(), r = await f.call(s.path,{headers:s.headers});
  const sid = cookie(r,sidCookie);
  const fake = sid.slice(0,-1)+(sid.endsWith('A')?'B':'A');
  assert.doesNotMatch(await (await f.call('/',{headers:{Cookie:fake}})).text(), /ログイン済み/);
  assert.equal((await f.call('/auth/logout',{method:'POST',headers:{Cookie:sid,Origin:'https://elsewhere.example'}})).status,403);
  const logout = await f.call('/auth/logout',{method:'POST',headers:{Cookie:sid,Origin:origin}});
  assert.equal(logout.status,303);
  assert.match(logout.headers.getSetCookie()[0], /Max-Age=0/);
  assert.doesNotMatch(await (await f.call('/',{headers:{Cookie:sid}})).text(), /ログイン済み/);
  const s2 = await f.start(), r2 = await f.call(s2.path,{headers:s2.headers});
  f.sessions.clear();
  assert.doesNotMatch(await (await f.call('/',{headers:{Cookie:cookie(r2,sidCookie)}})).text(), /ログイン済み/);
});

test('misconfigured environment, unapproved host and non-POST logout fail closed', async () => {
  const f = fixture();
  assert.equal((await f.app.fetch(new Request('https://other.example/auth/start'),f.env)).status,404);
  assert.equal((await f.call('/auth/logout')).status,405);
  delete f.env.GOOGLE_CLIENT_SECRET;
  assert.equal((await f.call('/auth/start')).status,503);
});

test('non-Gmail identity requires pinning immutable Google sub', async () => {
  const f = fixture({email:'owner@example.test'});
  f.env.HOMES_OWNER_EMAIL = 'owner@example.test';
  let s = await f.start();
  assert.equal((await f.call(s.path,{headers:s.headers})).status,403);
  f.env.HOMES_OWNER_SUB = 'account1';
  s = await f.start();
  assert.equal((await f.call(s.path,{headers:s.headers})).status,303);
});

test('OIDC accepts valid signed JWT and rejects wrong signature, issuer, audience, nonce, verification and expiry', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({keys:[{...await exportJWK(publicKey),alg:'RS256',kid:'test'}]});
  const now = Math.floor(Date.now()/1000);
  const make = (claims = {}, key = privateKey) => new SignJWT({
    iss:'https://accounts.google.com', aud:'test-client', sub:'account1',
    iat:now, exp:now+300, nonce:'nonce', email_verified:true,email:'owner@gmail.com', ...claims
  }).setProtectedHeader({alg:'RS256',kid:'test'}).sign(key);
  const verify = jwt => readGoogleIdentity(jwt,'test-client','nonce',keys);
  assert.deepEqual(await verify(await make()),{email:'owner@gmail.com',sub:'account1'});
  for (const claims of [{iss:'https://other.example'},{aud:'bad'},{nonce:'bad'},{email_verified:false},{exp:now-120},{azp:'bad'}]) {
    await assert.rejects(verify(await make(claims)));
  }
  await assert.rejects(verify(await make({},(await generateKeyPair('RS256')).privateKey)));
});
