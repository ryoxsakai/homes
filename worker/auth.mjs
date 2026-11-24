import { authorizedMember, readMembers } from './members.mjs';
import { handleHomesData } from './data.mjs';
import { installHead, isInstallPath, installResponse } from './install.mjs';
import { isPortalPath, portalResponse } from './portal.mjs';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const issuers = ['https://accounts.google.com', 'accounts.google.com'];
const stateTTL = 600;
const sessionTTL = 8 * 3600;
const sessionCookie = '__Host-homes-session';
const stateCookie = '__Host-homes-state';
const secureToken = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();
const paths = new Set(['/', '/auth/start', '/auth/callback', '/auth/logout']);
const sec = () => Math.floor(Date.now() / 1000);
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const token = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
const cookie = (name, value, maxAge) => `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;

function readCookie(request, name) {
  const values = (request.headers.get('Cookie') || '').split(';').map(x => x.trim())
    .filter(x => x.startsWith(name + '=')).map(x => x.slice(name.length + 1));
  return values.length === 1 && secureToken.test(values[0]) ? values[0] : null;
}

export async function readGoogleIdentity(idToken, clientId, nonce, keys = googleKeys) {
  if (typeof idToken !== 'string' || idToken.length > 8192) throw Error('bad identity');
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: issuers, audience: clientId, algorithms: ['RS256'], maxTokenAge: '10m',
    requiredClaims: ['iat', 'exp', 'sub', 'nonce'], clockTolerance: 10
  });
  if (payload.aud !== clientId || (payload.azp !== undefined && payload.azp !== clientId)
      || payload.nonce !== nonce || payload.email_verified !== true || typeof payload.email !== 'string') throw Error('bad identity');
  return { email: payload.email.toLowerCase(), sub: payload.sub };
}

const html = (title, body, head = '') => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} | Homes</title>${head}<main><h1>${title}</h1>${body}</main></html>`;
const shell = '<a href="/">Homesに戻る</a>';

function response(status, body = null, { cookies = [], location, type = 'text/html; charset=utf-8', referrer = 'no-referrer', csp = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } = {}) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': referrer,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': csp,
    'Content-Type': type
  });
  if (location) headers.set('Location', location);
  for (const v of cookies) headers.append('Set-Cookie', v);
  return new Response(body, { status, headers });
}

const redirect = (location, cookies = []) => response(303, null, { location, cookies });
const fail = (status, message, cookies = []) => response(status, html(message, shell), { cookies });
const one = (q, k) => q.getAll(k).length === 1 ? q.get(k) : null;

function configured(env, members) {
  try {
    const origin = new URL(env.HOMES_AUTH_ORIGIN);
    return origin.origin === env.HOMES_AUTH_ORIGIN && origin.protocol === 'https:'
      && !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET
      && !!members && !!env.AUTH_STORE;
  } catch { return false; }
}

export function createApp({ upstream = fetch, verify = readGoogleIdentity, portal, installIcon } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (isInstallPath(url.pathname)) return installResponse(request, url, env.HOMES_AUTH_ORIGIN, installIcon, response);
      const dataPath = url.pathname.startsWith('/api/');
      const portalPath = isPortalPath(url.pathname);
      const dataResponse = (status, error) => response(status, JSON.stringify({error}), {type:'application/json; charset=utf-8'});
      if (!paths.has(url.pathname) && !dataPath && !portalPath) return fail(404, 'ページがありません');
      const members = readMembers(env);
      if (!configured(env, members)) return dataPath ? dataResponse(503, 'unavailable') : fail(503, 'Homesのログインは準備中です');
      if (url.origin !== env.HOMES_AUTH_ORIGIN) return dataPath ? dataResponse(404, 'not_found') : fail(404, 'ページがありません');
      if (dataPath) {
        try {
          const raw = readCookie(request, sessionCookie);
          if (!raw) return dataResponse(401, 'unauthorized');
          const auth = env.AUTH_STORE.get(env.AUTH_STORE.idFromName('homes-auth-v1'));
          const session = await auth.readSession(await digest(raw));
          const member = authorizedMember(session, members);
          return await handleHomesData(request, env, member, response);
        } catch { return dataResponse(503, 'unavailable'); }
      }
      if (portalPath) {
        try {
          const raw = readCookie(request, sessionCookie);
          const store = raw && env.AUTH_STORE.get(env.AUTH_STORE.idFromName('homes-auth-v1'));
          const session = raw ? await store.readSession(await digest(raw)) : null;
          return portalResponse(request, url, authorizedMember(session, members), portal, response);
        } catch { return fail(503, '一時的に利用できません'); }
      }
      const method = url.pathname === '/auth/logout' ? 'POST' : 'GET';
      if (request.method !== method) return fail(405, 'この操作は利用できません');
      const store = env.AUTH_STORE.get(env.AUTH_STORE.idFromName('homes-auth-v1'));
      let sessionKey;
      const raw = readCookie(request, sessionCookie);
      const callback = env.HOMES_AUTH_ORIGIN + '/auth/callback';
      try {
        if (raw) sessionKey = await digest(raw);
        if (url.pathname === '/') {
          const session = sessionKey ? await store.readSession(sessionKey) : null;
          const signedIn = authorizedMember(session, members);
          if (signedIn && portal) return redirect('/app');
          if (signedIn && url.search) return redirect('/');
          return signedIn
            ? response(200, html('Homes', '<p>ログイン済みです。家庭用メニューは準備中です。</p><form method="post" action="/auth/logout"><button>ログアウト</button></form>'), { referrer: 'same-origin' })
            : response(200, html('Homes', '<p>許可されたGoogleアカウントでログインしてください。</p><a href="/auth/start">Googleでログイン</a>', installHead), {
              csp: "default-src 'none'; manifest-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
            });
        }
        if (url.pathname === '/auth/logout') {
          if (request.headers.get('Origin') !== url.origin) return fail(403, 'この操作は許可されていません');
          if (sessionKey) await store.removeSession(sessionKey);
          const existing = readCookie(request, stateCookie);
          if (existing) await store.takeState(await digest(existing));
          return redirect('/', [cookie(sessionCookie, '', 0), cookie(stateCookie, '', 0)]);
        }
        if (url.pathname === '/auth/start') {
          const stateToken = token(), nonce = token(), verifier = token();
          await store.putState(await digest(stateToken), nonce, verifier);
          const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          authorize.search = new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callback, response_type: 'code',
            scope: 'openid email', state: stateToken, nonce, code_challenge: await digest(verifier),
            code_challenge_method: 'S256', prompt: 'select_account'
          });
          return redirect(authorize.href, [cookie(stateCookie, stateToken, stateTTL)]);
        }
        const expired = [cookie(stateCookie, '', 0)];
        const state = one(url.searchParams, 'state');
        if (!state || state !== readCookie(request, stateCookie)) return fail(400, 'ログインの確認に失敗しました');
        const attempt = await store.takeState(await digest(state));
        if (!attempt) return fail(400, 'ログインの有効期限が切れました', expired);
        const code = one(url.searchParams, 'code');
        if (url.searchParams.has('error') || !code || code.length > 2048) return fail(400, 'ログインを完了できませんでした', expired);
        try {
          const result = await upstream('https://oauth2.googleapis.com/token', {
            method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
            body: new URLSearchParams({
              code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
              redirect_uri: callback, code_verifier: attempt.verifier, grant_type: 'authorization_code'
            })
          });
          if (!result.ok) throw Error('token exchange failed');
          const { id_token } = await result.json();
          const identity = await verify(id_token, env.GOOGLE_CLIENT_ID, attempt.nonce);
          if (!authorizedMember(identity, members)) return fail(403, 'このアカウントにはアクセス権がありません', expired);
          const newSession = token();
          await store.replaceSession(await digest(newSession), identity.email, identity.sub, sessionKey);
          return redirect('/', [...expired, cookie(sessionCookie, newSession, sessionTTL)]);
        } catch { return fail(502, 'Googleログインを完了できませんでした', expired); }
      } catch { return fail(503, '一時的に利用できません'); }
    }
  };
}

export { sec, stateTTL, sessionTTL };
