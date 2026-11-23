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

function allowed(email, sub, env) {
  if (typeof email !== 'string' || typeof sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(sub)) return false;
  const owner = env.HOMES_OWNER_EMAIL?.trim().toLowerCase();
  // For an external email address Google may not be authoritative. Pin its stable sub.
  return owner === email.toLowerCase() && (env.HOMES_OWNER_SUB ? env.HOMES_OWNER_SUB === sub : owner.endsWith('@gmail.com'));
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

const html = (title, body) => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} | Homes</title><main><h1>${title}</h1>${body}</main></html>`;
const shell = '<a href="/">Homesに戻る</a>';

function response(status, body = null, { cookies = [], location, type = 'text/html; charset=utf-8' } = {}) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Content-Type': type
  });
  if (location) headers.set('Location', location);
  for (const v of cookies) headers.append('Set-Cookie', v);
  return new Response(body, { status, headers });
}

const redirect = (location, cookies = []) => response(303, null, { location, cookies });
const fail = (status, message, cookies = []) => response(status, html(message, shell), { cookies });
const one = (q, k) => q.getAll(k).length === 1 ? q.get(k) : null;

function configured(env) {
  try {
    const origin = new URL(env.HOMES_AUTH_ORIGIN);
    return origin.origin === env.HOMES_AUTH_ORIGIN && origin.protocol === 'https:'
      && !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET
      && !!env.HOMES_OWNER_EMAIL?.trim() && !!env.AUTH_STORE;
  } catch { return false; }
}

export function createApp({ upstream = fetch, verify = readGoogleIdentity } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (!paths.has(url.pathname)) return fail(404, 'ページがありません');
      if (!configured(env)) return fail(503, 'Homesのログインは準備中です');
      if (url.origin !== env.HOMES_AUTH_ORIGIN) return fail(404, 'ページがありません');
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
          return session && allowed(session.email, session.sub, env)
            ? response(200, html('Homes', '<p>ログイン済みです。家庭用メニューは準備中です。</p><form method="post" action="/auth/logout"><button>ログアウト</button></form>'))
            : response(200, html('Homes', '<p>許可されたGoogleアカウントでログインしてください。</p><a href="/auth/start">Googleでログイン</a>'));
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
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
            body: new URLSearchParams({
              code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
              redirect_uri: callback, code_verifier: attempt.verifier, grant_type: 'authorization_code'
            })
          });
          if (!result.ok) throw Error('token exchange failed');
          const { id_token } = await result.json();
          const identity = await verify(id_token, env.GOOGLE_CLIENT_ID, attempt.nonce);
          if (!allowed(identity.email, identity.sub, env)) return fail(403, 'このアカウントにはアクセス権がありません', expired);
          const newSession = token();
          await store.replaceSession(await digest(newSession), identity.email, identity.sub, sessionKey);
          return redirect('/', [...expired, cookie(sessionCookie, newSession, sessionTTL)]);
        } catch { return fail(502, 'Googleログインを完了できませんでした', expired); }
      } catch { return fail(503, '一時的に利用できません'); }
    }
  };
}

export { sec, stateTTL, sessionTTL };
