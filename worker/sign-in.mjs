import { installHead } from './install.mjs';

// No JavaScript, fonts or tracking requests on the public sign-in page.
// The response CSP pins this one stylesheet; the test guards the hash.
const css = `
:root{color-scheme:light;--ink:#2c211c;--quiet:#684f40;--line:#e8ded2;--accent:#984324;--surface:#fffcf8;--page:#f6f1ea;font-family:"M PLUS 2","Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:radial-gradient(ellipse at top,#f6e7dc,transparent 58%),var(--page);color:var(--ink)}
main{width:min(100%,400px);padding:clamp(24px,7vw,40px);border:1px solid var(--line);border-radius:24px;background:var(--surface);box-shadow:0 2px 6px #3c241614,0 16px 44px #3c241614;text-align:center}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;color:var(--ink);font-size:25px;font-weight:800;letter-spacing:.02em}
.brand img{display:block;width:50px;height:50px;object-fit:contain;border-radius:10px}
h1{margin:24px 0 8px;font-size:22px;font-weight:750;line-height:1.38;overflow-wrap:anywhere}
p{margin:0;color:var(--quiet);font-size:14px;line-height:1.7;overflow-wrap:anywhere}
.action{margin-top:24px}
.google,.back{display:inline-flex;min-height:44px;max-width:100%;align-items:center;justify-content:center;padding:0 12px;border:1px solid #747775;border-radius:99px;background:#fff;color:#1f1f1f;text-decoration:none;font:500 14px/20px "Google Sans",Arial,"Hiragino Sans",sans-serif}
.google{gap:10px}
.google img{flex:none;width:18px;height:18px;object-fit:contain}
.google:hover,.back:hover{background:#f5f8fd}
.google:focus-visible,.back:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.note{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:24px;padding-top:16px;border-top:1px solid var(--line);font-size:12px}
.note svg{flex:none}
@media (max-height:480px){body{place-items:start center}}
`;

// Google-provided standard multicolour mark, resized proportionally for a local asset:
// https://developers.google.com/static/identity/images/g-logo.png
const googleMark = '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';
const lock = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
const escape = text => String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const signInCsp = "default-src 'none'; style-src 'sha256-d65gYBd8aeVSTkG62DaZyyjZxVpESZ1Lk18duMj+47U='; img-src 'self' data:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function signInPage(error) {
  const title = error ? escape(error) : 'Homesにログイン';
  const content = error
    ? '<p>ログイン画面に戻って、もう一度お試しください。</p><div class="action"><a class="back" href="/">Homesに戻る</a></div>'
    : `<p>家族のToDo、メモ、買い物、本棚をひとつに。</p>
       <div class="action"><a class="google" href="/auth/start"><img src="data:image/png;base64,${googleMark}" width="18" height="18" alt="">Googleでログイン</a></div>
       <p class="note">${lock}許可されたGoogleアカウントのみ利用できます。</p>`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f6f1ea">
<title>${title} | Homes</title>
${installHead}
<style>${css}</style>
</head>
<body><main aria-labelledby="screen-title">
<div class="brand"><img src="/homes-icon.png" width="50" height="50" alt=""><span>Homes</span></div>
<h1 id="screen-title">${title}</h1>
${content}
</main></body>
</html>`;
}
