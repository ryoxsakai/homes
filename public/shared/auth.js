// Homes replacement for Works' shared/auth.js.
// Homes authenticates with an HttpOnly, server-side session cookie set by the
// Worker. No token is visible to scripts, so this module only exposes the same
// function names Works pages call, backed by same-origin requests.

let signedIn = false;

// When the 8-hour session ends, any API call answers 401. Clear the screen by
// leaving for the sign-in page instead of keeping household data on display.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (response.status === 401 && url.origin === location.origin && url.pathname.startsWith("/api/")) expire();
  return response;
};
function expire() {
  if (!signedIn) return;
  signedIn = false;
  publish(null); // A mobile service frame hands this to the outer page.
  if (window === top) location.replace("/");
}

function publish(user) {
  window.__worksUser = user;
  window.dispatchEvent(new CustomEvent("works-user", { detail: user }));
}

// Works pages send "Bearer <token>" headers; Homes ignores them. A truthy value
// keeps their "signed in?" checks working without revealing anything.
export function getSessionToken() {
  return signedIn ? "cookie-session" : null;
}

// Homes never receives Google access tokens.
export async function getGoogleAccessToken() {
  return null;
}

export async function watchAuth({ onSignedIn, onSignedOut }) {
  try {
    const response = await fetch("/api/me", { cache: "no-store", credentials: "same-origin" });
    if (response.status === 401) {
      publish(null);
      onSignedOut?.(null);
      if (window === top) location.replace("/");
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const me = await response.json();
    signedIn = true;
    const user = { email: me.name, name: me.name, picture: "" };
    publish(user);
    await onSignedIn?.(user);
  } catch {
    signedIn = false;
    publish(null);
    onSignedOut?.("サーバーに接続できませんでした。再読み込みしてください。");
  }
}

export function isStandaloneHomeScreenApp() {
  return Boolean(window.navigator.standalone);
}

export function signIn() {
  window.location.assign("/auth/start");
}

export async function signOutUser() {
  try {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin", redirect: "manual" });
  } catch {
    // The server session still expires; the page reload below shows sign-in.
  }
  signedIn = false;
  publish(null);
}
