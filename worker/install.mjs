const manifestPath = '/homes.webmanifest';
const iconPath = '/homes-icon.png';

const manifest = JSON.stringify({
  id: '/', name: 'Homes', short_name: 'Homes', lang: 'ja',
  start_url: '/', scope: '/', display: 'standalone',
  theme_color: '#fffcf8', background_color: '#f6f1ea',
  icons: [{ src: iconPath, sizes: '600x600', type: 'image/png', purpose: 'any' }]
});

export const installHead = `<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Homes">
<link rel="manifest" href="${manifestPath}">
<link rel="apple-touch-icon" sizes="600x600" href="${iconPath}">`;
export const isInstallPath = path => path === manifestPath || path === iconPath;

export function installResponse(request, url, icon, respond) {
  if (request.method !== 'GET') return respond(405);
  if (url.pathname === manifestPath) {
    return respond(200, manifest, {type: 'application/manifest+json; charset=utf-8'});
  }
  return icon ? respond(200, icon, {type: 'image/png'}) : respond(404);
}
