// Homes app shell (ported from Works) shared by every page: app navigation (PC sidebar / mobile
// drawer) and quick add. Pages keep their own settings and account buttons.
import { enableMenuSwipes } from "./menu-swipe.mjs?v=1";
import "./theme.js?v=7";
import { isListedServicePath } from "./menu-visibility.mjs";

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  tutor: '<path d="M22 9 12 4 2 9l10 5 10-5Z"/><path d="M6 11.2V16c3.3 2.4 8.7 2.4 12 0v-4.8"/><path d="M22 9v6"/>',
  material: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  admission: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  workflow: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  wiki: '<path d="M2 5h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 5h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/>',
  todo: '<path d="m9 11 3 3 9-9"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  memo: '<path d="M15 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z"/><path d="M15 21v-6h6"/>',
  grocery: '<path d="M4.5 9h15l-1.6 9.6a2 2 0 0 1-2 1.7H8.1a2 2 0 0 1-2-1.7z"/><path d="m8.5 9 3.5-5.5L15.5 9"/><path d="M9.5 13v3.5M14.5 13v3.5"/>',
  cleaning: '<path d="M11 3.5 12.6 8l4.4 1.6-4.4 1.6L11 15.5 9.4 11.2 5 9.6 9.4 8z"/><path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>',
  books: '<path d="M5 4h3v16H5z"/><path d="M10 4h3v16h-3z"/><path d="m15 5.2 2.9-.8 3.6 14.6-2.9.8z"/><path d="M3 20h18"/>',
  kdp: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  ss: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
// Each app gets a quiet tint of the same lightness and strength, so the sidebar, the
// mobile service bar and quick add read as one set and each app is told apart by hue.
const TINTS = {
  home: ["#f6e7dc", "#984324"], todo: ["#f8e4d8", "#a3401c"], memo: ["#fbefd2", "#8a5a00"],
  grocery: ["#f8e1e4", "#9e3048"], cleaning: ["#dff0ee", "#23675f"], books: ["#e6efe0", "#3f6a2e"],
};
// One order everywhere: sidebar, drawer, mobile service bar and quick add.
const services = [
  ["/todo/", "todo", "ToDo"], ["/memo/", "memo", "メモ"],
  ["/grocery/", "grocery", "食料品"], ["/cleaning/", "cleaning", "掃除"],
  ["/books/", "books", "本棚"],
].filter(([href]) => isListedServicePath(href));
const QUICK = [
  ["todo", "/todo/#works-quick=todo", "ToDoを追加", "タイトルと日付だけですぐ登録"],
  ["memo", "/memo/#works-quick=memo", "メモを追加", "思いついたことを書き留める"],
  ["grocery", "/grocery/#works-quick=grocery", "買うものを追加", "品名だけで買い物リストへ"],
  ["cleaning", "/cleaning/#works-quick=cleaning", "掃除場所を追加", "場所と頻度を決めて登録"],
  ["books", "/books/#works-quick=books", "本を登録", "バーコードを読み取って本棚に追加"],
];

const svg = (name, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const appIcon = (key) =>
  `<span class="works-app-icon" style="--app-tint:${TINTS[key][0]};--app-ink:${TINTS[key][1]}">${svg(key, 18)}</span>`;

const header = document.querySelector(".works-header");
const actions = header?.querySelector(".works-header-actions");
if (actions) {
  document.body.classList.add("works-shell");
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--works-header-height", `${header.getBoundingClientRect().height}px`);
  }).observe(header);
  const homeLink = header.querySelector(".works-home");
  // Reuse page-specific unsaved-change guards (Wiki/KDP) for every destination.
  const guard = (link) => link.addEventListener("click", (event) => {
    if (typeof homeLink?.onclick === "function") homeLink.onclick(event);
  });

  // App navigation. A <details> keeps the mobile drawer keyboard-accessible;
  // on PC the same list is shown permanently as the left sidebar.
  const navigation = document.createElement("details");
  navigation.className = "works-navigation";
  navigation.innerHTML = `<summary aria-label="サービス一覧">${svg("menu", 22)}</summary>
    <nav aria-label="Homes サービス">${services.map(([href, key, text]) =>
      `<a href="${href}">${appIcon(key)}<span>${text}</span></a>`).join("")}</nav>`;
  navigation.querySelectorAll("a").forEach((link) => {
    if (link.pathname === location.pathname) link.setAttribute("aria-current", "page");
    guard(link);
  });
  const serviceBar = document.createElement("nav");
  serviceBar.className = "works-service-bar";
  serviceBar.setAttribute("aria-label", "サービス切り替え");
  const currentPath = location.pathname.replace(/index\.html$/, "");
  for (const [href, icon, label] of services) {
    const link = document.createElement("a");
    link.href = href;
    link.setAttribute("aria-label", label);
    link.title = label;
    link.innerHTML = appIcon(icon);
    if (currentPath === href || (href === "/material/" && currentPath === "/material-print/"))
      link.setAttribute("aria-current", "page");
    guard(link);
    serviceBar.append(link);
  }
  document.body.append(serviceBar);
  enableMenuSwipes();

  // Older engines without ::details-content keep the PC sidebar open with JS.
  const desktop = window.matchMedia("(min-width: 1024px)");
  const supportsContent = CSS.supports?.("selector(::details-content)");
  const syncDesktop = () => { if (!supportsContent && desktop.matches) navigation.open = true; };
  // The browser drops focus from a link that becomes hidden, so remember it.
  let navHasFocus = false;
  document.addEventListener("focusin", (event) => {
    navHasFocus = navigation.querySelector("nav").contains(event.target);
  });
  desktop.addEventListener?.("change", () => {
    // Leaving PC hides the sidebar; keep keyboard focus on the drawer toggle.
    const active = document.activeElement;
    if (!desktop.matches && !navigation.open && navHasFocus && (!active || active === document.body || navigation.contains(active))) {
      navigation.querySelector("summary").focus();
    }
    syncDesktop();
  });
  document.addEventListener("click", (event) => {
    if (!navigation.contains(event.target) || event.target === navigation) navigation.open = false;
    syncDesktop();
  });
  navigation.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      navigation.open = false;
      syncDesktop();
      navigation.querySelector("summary").focus();
    }
  });
  navigation.addEventListener("toggle", () => {
    document.documentElement.classList.toggle("works-drawer-open", navigation.open && !desktop.matches);
  });
  syncDesktop();

  // Quick add: jump straight into the add form of ToDo or Memo.
  const quick = document.createElement("div");
  quick.className = "works-quick";
  quick.innerHTML = `<button type="button" class="works-quick-add" aria-label="クイック追加" aria-haspopup="true" aria-expanded="false">${svg("plus", 18)}<span class="works-quick-add-label">追加</span></button>
    <div class="works-quick-menu" hidden>${QUICK.map(([key, href, title, hint]) => `<a href="${href}">${appIcon(key)}<span>${title}<small>${hint}</small></span></a>`).join("")}</div>`;
  const quickButton = quick.querySelector("button");
  const quickMenu = quick.querySelector(".works-quick-menu");
  const setQuick = (open) => {
    quickMenu.hidden = !open;
    quickButton.setAttribute("aria-expanded", String(open));
  };
  quickButton.addEventListener("click", () => {
    navigation.open = false;
    syncDesktop();
    setQuick(quickMenu.hidden);
    if (!quickMenu.hidden) quickMenu.querySelector("a").focus();
  });
  quickMenu.querySelectorAll("a").forEach((link) => {
    guard(link);
    link.addEventListener("click", () => setQuick(false));
  });
  document.addEventListener("click", (event) => { if (!quick.contains(event.target)) setQuick(false); });
  quick.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !quickMenu.hidden) { setQuick(false); quickButton.focus(); }
  });
  // Same order on every service: settings, account, then quick add on the far right.
  actions.append(quick);
  syncAvatar(window.__worksUser);
  window.addEventListener("works-user", (event) => syncAvatar(event.detail));
  // Keep the logical order: menu, brand, then actions.
  header.prepend(navigation);

  runQuickAdd();
  window.addEventListener("hashchange", runQuickAdd);
}

// Homes supplies an authenticated same-origin image, never an OAuth provider URL.
function syncAvatar(user) {
  const button = document.querySelector(".works-header .user-icon-btn");
  if (!button) return;
  const previous = button.querySelector(".works-avatar-photo");
  if (user?.picture === "/avatar" && previous) return;
  previous?.remove();
  button.classList.remove("has-photo");
  if (user?.picture !== "/avatar") return;

  button.classList.add("works-account");
  const photo = document.createElement("img");
  photo.className = "works-avatar-photo";
  photo.alt = "";
  photo.hidden = true;
  photo.addEventListener("load", () => {
    if (!button.contains(photo)) return;
    photo.hidden = false;
    button.classList.add("has-photo");
  }, { once: true });
  photo.addEventListener("error", () => {
    if (!button.contains(photo)) return;
    photo.remove();
    button.classList.remove("has-photo");
  }, { once: true });
  button.append(photo);
  photo.src = user.picture;
}

// Open the target page's own add form once that page has finished loading.
function runQuickAdd() {
  const kind = new URLSearchParams(location.hash.slice(1)).get("works-quick");
  const target = { "/todo/": "todo", "/memo/": "memo", "/grocery/": "grocery", "/cleaning/": "cleaning", "/books/": "books" }[location.pathname];
  if (!kind || kind !== target) return;
  const clearHash = () => history.replaceState(null, "", location.pathname + location.search);
  // Bookshelf, grocery and cleaning pages expose their add action once they have loaded.
  const hook = { books: "homesBooksQuickAdd", grocery: "homesQuickAdd", cleaning: "homesQuickAdd" }[kind];
  const ready = hook
    ? () => (document.body.dataset.serviceReady === "true" && typeof window[hook] === "function" ? () => window[hook]() : null)
    : kind === "todo"
    ? () => { const app = document.getElementById("app"); const button = document.getElementById("new-task"); return app && !app.hidden && button ? () => button.click() : null; }
    : () => (document.querySelector("#login-screen")?.classList.contains("hidden") && typeof window.openMemoModal === "function" ? () => window.openMemoModal(null) : null);
  const started = Date.now();
  const attempt = () => {
    const open = ready();
    if (open) { clearHash(); open(); return; }
    if (Date.now() - started < 20000) setTimeout(attempt, 150);
  };
  attempt();
}
