import { installHead } from './install.mjs';

// Every Works-derived page and asset is private: the Worker serves it from the
// static-assets binding only to a signed-in family member (run_worker_first).
const pagePaths = new Set(['/app', '/todo', '/todo/', '/memo', '/memo/', '/grocery', '/grocery/', '/cleaning', '/cleaning/', '/books', '/books/']);
const assetPrefixes = ['/todo/', '/memo/', '/grocery/', '/cleaning/', '/books/', '/shared/', '/dashboard/vendor/'];
const canonical = new Map([['/todo', '/todo/'], ['/memo', '/memo/'], ['/grocery', '/grocery/'], ['/cleaning', '/cleaning/'], ['/books', '/books/']]);

export const appCsp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'self'";

// Resumes the last used service (Works behaviour); only the screen path is stored locally.
export const appShell = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Homes</title>${installHead}<script type="module" src="/shared/app-entry.mjs"></script><noscript>JavaScriptを有効にしてください。</noscript></html>`;

export const isPortalPath = path => pagePaths.has(path) || assetPrefixes.some(prefix => path.startsWith(prefix));

const isDocument = path => pagePaths.has(path) || path.endsWith('/') || path.endsWith('.html');

export async function portalResponse(request, url, member, assets, respond) {
  if (!member || !assets) {
    return isDocument(url.pathname) && request.method === 'GET'
      ? respond(303, null, { location: '/' })
      : respond(404);
  }
  if (request.method !== 'GET') return respond(405);
  if (url.pathname === '/app') {
    if (url.search) return respond(303, null, { location: '/app' });
    return respond(200, appShell, { referrer: 'same-origin', csp: appCsp });
  }
  if (canonical.has(url.pathname)) return respond(308, null, { location: canonical.get(url.pathname) + url.search });
  if (url.pathname.split('/').some(part => part === '..' || part.startsWith('.'))) return respond(404);
  const asset = await assets.fetch(new Request(new URL(url.pathname, url.origin), { method: 'GET' }));
  if (asset.status !== 200) return respond(404);
  const type = asset.headers.get('Content-Type') || 'application/octet-stream';
  const csp = url.pathname === '/books/' || url.pathname === '/books/index.html'
    ? appCsp.replace("img-src 'self' data:;", "img-src 'self' data: blob:;") : appCsp;
  return type.startsWith('text/html')
    ? respond(200, asset.body, { type, referrer: 'same-origin', csp })
    : respond(200, asset.body, { type });
}
