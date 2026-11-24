const contentTypes = new Map([
  ['/app', ['html', 'text/html; charset=utf-8']],
  ['/assets/homes-app.css', ['css', 'text/css; charset=utf-8']],
  ['/assets/homes-app.mjs', ['js', 'text/javascript; charset=utf-8']]
]);

const appleTouchIcon = 'https://ryoxsakai.github.io/homes/Homes.png';
const appCsp = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: ${appleTouchIcon}; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`;

export const isPortalPath = path => contentTypes.has(path);

export function portalResponse(request, url, session, portal, respond) {
  const [key, type] = contentTypes.get(url.pathname);
  if (!session || !portal) {
    return url.pathname === '/app' && request.method === 'GET'
      ? respond(303, null, { location: '/' })
      : respond(404);
  }
  if (request.method !== 'GET') return respond(405);
  // Do not create a same-origin referrer containing arbitrary query content.
  if (url.search) return respond(303, null, { location: url.pathname });
  return respond(200, portal[key], key === 'html'
    ? { type, referrer: 'same-origin', csp: appCsp }
    : { type });
}
