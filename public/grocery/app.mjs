// Homes 食料品: what to buy, and what was bought with its best-before date.
// Ported from ryoxsakai/grocery-checker; saved as one household document (/api/grocery).
import { watchAuth, signOutUser } from '../shared/auth.js?v=14';
import { $, esc, collator, today, addDays, daysBetween, shortDay, dueLabel, toast,
  createDocument, openDialog, wireDialogs, categoryManager, categoryOptions } from '../shared/homes-doc.mjs?v=1';

const PREFS_KEY = 'homes-grocery-view';
let state = { toBuy: [], purchased: [], categories: [] };
let loaded = false;
const ui = { view: 'tobuy', category: '*', addCategory: null, sort: 'expiry' };
try { Object.assign(ui, pick(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'))); } catch {}
function pick(saved) {
  const out = {};
  if (['tobuy', 'bought'].includes(saved.view)) out.view = saved.view;
  if (['expiry', 'bought-desc', 'name'].includes(saved.sort)) out.sort = saved.sort;
  for (const key of ['category', 'addCategory']) {
    if (typeof saved[key] === 'string' && saved[key].length <= 50) out[key] = saved[key];
  }
  return out;
}
const remember = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(ui)); } catch {} };

const doc = createDocument('/api/grocery', {
  render: () => render(),
  // Keep who added / bought what (decided by the server) without disturbing newer edits.
  onSaved(saved) {
    const byId = new Map([...saved.toBuy, ...saved.purchased].map(i => [i.id, i]));
    for (const item of [...state.toBuy, ...state.purchased]) {
      const persisted = byId.get(item.id);
      if (!persisted) continue;
      item.addedBy = persisted.addedBy;
      if ('purchasedBy' in persisted) item.purchasedBy = persisted.purchasedBy;
    }
  },
});
const snapshot = () => structuredClone({ toBuy: state.toBuy, purchased: state.purchased, categories: state.categories });
const save = (message, undo) => doc.save(snapshot(), message, undo);

// ─── Freshness ───────────────────────────────────────────────────────
function freshness(item) {
  if (!item.expiryDate) return { text: '期限なし', state: 'none', ratio: null };
  const label = dueLabel(daysBetween(today(), item.expiryDate));
  const span = Math.max(1, daysBetween(item.purchasedDate, item.expiryDate));
  const ratio = Math.min(1, Math.max(0, daysBetween(item.purchasedDate, today()) / span));
  return { ...label, ratio };
}
const rank = name => name ? (state.categories.indexOf(name) + 1 || Infinity) : Infinity;
const matchesCategory = item => ui.category === '*' || item.category === ui.category;

// ─── Render ──────────────────────────────────────────────────────────
const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

function render() {
  if (!loaded) return;
  const expired = state.purchased.filter(i => i.expiryDate && daysBetween(today(), i.expiryDate) < 0).length;
  const soon = state.purchased.filter(i => i.expiryDate && (d => d >= 0 && d <= 3)(daysBetween(today(), i.expiryDate))).length;
  $('#summary').innerHTML = [`買うもの ${state.toBuy.length}件`,
    expired ? `<strong>期限切れ ${expired}件</strong>` : '', soon ? `期限間近 ${soon}件` : ''].filter(Boolean).join('・');
  $('#count-tobuy').textContent = state.toBuy.length;
  $('#count-bought').textContent = state.purchased.length;
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === ui.view));
  $('#view-tobuy').hidden = ui.view !== 'tobuy';
  $('#view-bought').hidden = ui.view !== 'bought';
  document.querySelector('[data-for="bought"]').hidden = ui.view !== 'bought';
  const savedFilter = ui.category;
  const savedAdd = ui.addCategory;
  ui.category = categoryOptions($('#filter-category'), state.categories, savedFilter, { any: 'すべてのカテゴリ' });
  const shownAdd = categoryOptions($('#add-category'), state.categories, savedAdd);
  if (savedAdd !== null && savedAdd !== shownAdd) ui.addCategory = null;
  if (ui.category !== savedFilter || ui.addCategory !== savedAdd) remember();
  $('#filter-category').classList.toggle('is-filtered', ui.category !== '*');
  $('#sort').value = ui.sort;
  renderToBuy();
  renderBought();
}

function renderToBuy() {
  const items = state.toBuy.filter(matchesCategory);
  const groups = new Map();
  for (const item of [...items].sort((a, b) => rank(a.category) - rank(b.category))) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  $('#tobuy-list').innerHTML = [...groups].map(([category, list]) => `
    <h3 class="homes-group-title">${esc(category || '未分類')}<span class="homes-count">${list.length}</span></h3>
    <ul class="homes-panel">${list.map(item => `
      <li class="homes-row">
        <button type="button" class="homes-check" data-buy="${esc(item.id)}" aria-label="「${esc(item.name)}」を買った" title="買った"><span>${CHECK}</span></button>
        <button type="button" class="homes-row-main" data-edit="${esc(item.id)}">
          <span class="homes-row-title">${esc(item.name)}</span>
          ${item.addedBy ? `<span class="homes-row-meta">${esc(item.addedBy)}が追加</span>` : ''}
        </button>
      </li>`).join('')}
    </ul>`).join('');
  $('#tobuy-empty').hidden = items.length > 0;
  $('#tobuy-empty p').textContent = state.toBuy.length ? 'このカテゴリの買うものはありません' : '買うものはありません。上の欄から追加できます。';
}

const boughtSorters = {
  expiry: (a, b) => (a.expiryDate ? 0 : 1) - (b.expiryDate ? 0 : 1) || (a.expiryDate || '').localeCompare(b.expiryDate || '') || collator.compare(a.name, b.name),
  'bought-desc': (a, b) => b.purchasedDate.localeCompare(a.purchasedDate) || collator.compare(a.name, b.name),
  name: (a, b) => collator.compare(a.name, b.name),
};

function renderBought() {
  const items = state.purchased.filter(matchesCategory).sort(boughtSorters[ui.sort]);
  $('#bought-list').innerHTML = items.map(item => {
    const f = freshness(item);
    return `<li class="homes-row${f.state === 'over' ? ' is-overdue' : ''}">
      <button type="button" class="homes-row-main" data-edit="${esc(item.id)}">
        <span class="homes-row-title">${esc(item.name)}</span>
        <span class="homes-row-meta">
          ${item.category ? `<span class="homes-chip">${esc(item.category)}</span>` : ''}
          <span>${shortDay(item.purchasedDate)}に購入${item.purchasedBy ? `（${esc(item.purchasedBy)}）` : ''}</span>
        </span>
      </button>
      <span class="homes-row-side">
        <span class="homes-due" data-state="${f.state}">${f.text}</span>
        ${f.ratio === null ? '' : `<span class="homes-meter" data-state="${f.state}" aria-hidden="true"><span style="width:${Math.round(f.ratio * 100)}%"></span></span>`}
      </span>
    </li>`;
  }).join('');
  $('#bought-list').hidden = items.length === 0;
  $('#bought-empty').hidden = items.length > 0;
  $('#bought-empty p').textContent = state.purchased.length ? 'このカテゴリの買ったものはありません' : '買ったものはまだありません。買うものの ◯ を押すとここに移ります。';
}

// ─── Actions ─────────────────────────────────────────────────────────
function addToBuy(name, category) {
  name = name.trim().slice(0, 200);
  if (!name) return false;
  if (state.toBuy.length >= 1000) { toast('買うものは1000件までです'); return false; }
  state.toBuy.push({ id: crypto.randomUUID(), name, category, addedOn: today(), addedBy: null });
  save(`「${name}」を追加しました`);
  return true;
}

function markBought(id) {
  const index = state.toBuy.findIndex(i => i.id === id);
  if (index < 0) return;
  const [item] = state.toBuy.splice(index, 1);
  const bought = { id: item.id, name: item.name, category: item.category, purchasedDate: today(), expiryDate: null, addedBy: item.addedBy ?? null, purchasedBy: null };
  state.purchased.unshift(bought);
  save(`「${item.name}」を買ったものに移しました`, () => {
    // Undo puts it back exactly where it was.
    state.purchased = state.purchased.filter(i => i.id !== item.id);
    state.toBuy.splice(Math.min(index, state.toBuy.length), 0, item);
    save('元に戻しました');
  });
}

// ─── Edit dialog ─────────────────────────────────────────────────────
const dialog = $('#item-dialog');
const form = $('#item-form');
let editing = null;
let initial = '';
const values = () => JSON.stringify([form.name.value, form.category.value, form.purchasedDate.value, form.expiryDate.value]);

function openEditor(id) {
  const bought = state.purchased.find(i => i.id === id);
  editing = bought || state.toBuy.find(i => i.id === id);
  if (!editing) return;
  $('#item-title').textContent = bought ? '買ったもの' : '買うもの';
  form.name.value = editing.name;
  categoryOptions(form.category, state.categories, editing.category);
  $('#bought-fields').hidden = !bought;
  $('#buy-again').hidden = !bought;
  form.purchasedDate.value = bought?.purchasedDate || today();
  form.expiryDate.value = bought?.expiryDate || '';
  $('#item-meta').textContent = [editing.addedBy && `${editing.addedBy}が追加`, bought?.purchasedBy && `${bought.purchasedBy}が購入`].filter(Boolean).join('・');
  initial = values();
  openDialog(dialog);
}

for (const button of document.querySelectorAll('[data-days]')) {
  button.addEventListener('click', () => {
    form.expiryDate.value = addDays(form.purchasedDate.value || today(), Number(button.dataset.days));
  });
}
$('#clear-expiry').addEventListener('click', () => { form.expiryDate.value = ''; });

form.addEventListener('submit', event => {
  event.preventDefault();
  const name = form.name.value.trim();
  if (!name) { toast('品名を入力してください'); form.name.focus(); return; }
  const bought = state.purchased.includes(editing);
  if (bought) {
    if (!form.purchasedDate.value) { toast('購入日を入力してください'); form.purchasedDate.focus(); return; }
    if (form.expiryDate.value && form.expiryDate.value < form.purchasedDate.value) { toast('賞味期限は購入日以降にしてください'); form.expiryDate.focus(); return; }
    editing.purchasedDate = form.purchasedDate.value;
    editing.expiryDate = form.expiryDate.value || null;
  }
  editing.name = name.slice(0, 200);
  editing.category = form.category.value;
  initial = values();
  dialog.close();
  save('保存しました');
});

$('#delete-item').addEventListener('click', () => {
  if (!editing || !confirm(`「${editing.name}」を削除しますか？`)) return;
  const item = editing;
  const inToBuy = state.toBuy.includes(item);
  const list = inToBuy ? state.toBuy : state.purchased;
  const index = list.indexOf(item);
  list.splice(index, 1);
  initial = values();
  dialog.close();
  save('削除しました', () => {
    (inToBuy ? state.toBuy : state.purchased).splice(index, 0, item);
    save('元に戻しました');
  });
});

$('#buy-again').addEventListener('click', () => {
  if (!editing) return;
  initial = values();
  dialog.close();
  if (state.toBuy.some(i => i.name === editing.name)) { toast(`「${editing.name}」はすでに買うものにあります`); return; }
  addToBuy(editing.name, editing.category);
});

wireDialogs(d => d === dialog && values() !== initial);

const categories = categoryManager({
  dialog: $('#category-dialog'),
  get: () => state.categories,
  set(names, change) {
    state.categories = names;
    if (change) for (const item of [...state.toBuy, ...state.purchased]) if (item.category === change.from) item.category = change.to;
    if (change) {
      if (ui.category === change.from) ui.category = change.to || '*';
      if (ui.addCategory === change.from) ui.addCategory = change.to || null;
      remember();
    }
  },
  countFor: name => [...state.toBuy, ...state.purchased].filter(i => i.category === name).length,
  onChange: () => save(),
});

// ─── Wiring ──────────────────────────────────────────────────────────
function focusAdd() {
  ui.view = 'tobuy';
  remember();
  render();
  $('#add-name').focus();
  $('#add-form').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
window.homesQuickAdd = focusAdd;

$('#add-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#add-name');
  const category = $('#add-category').value;
  if (addToBuy(input.value, category)) {
    ui.addCategory = category;
    remember();
    input.value = '';
  }
  input.focus();
});
$('#tobuy-list').addEventListener('click', event => {
  const buy = event.target.closest('[data-buy]');
  if (buy) return markBought(buy.dataset.buy);
  const edit = event.target.closest('[data-edit]');
  if (edit) openEditor(edit.dataset.edit);
});
$('#bought-list').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit]');
  if (edit) openEditor(edit.dataset.edit);
});
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => { ui.view = button.dataset.view; remember(); render(); });
}
$('#filter-category').addEventListener('change', event => { ui.category = event.target.value; remember(); render(); });
$('#add-category').addEventListener('change', event => { ui.addCategory = event.target.value; remember(); });
$('#sort').addEventListener('change', event => { ui.sort = event.target.value; remember(); render(); });
$('#open-add').addEventListener('click', focusAdd);
$('#menu-add').addEventListener('click', focusAdd);
$('#open-categories').addEventListener('click', () => categories.open());
$('#menu-list').addEventListener('click', () => scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
$('#sign-out').addEventListener('click', async () => {
  if (!confirm('ログアウトしますか？')) return;
  await signOutUser();
  if (window === top) location.replace('/');
});
// Days move on: re-render when the page comes back, so 「あと◯日」 stays right.
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

watchAuth({
  async onSignedIn() {
    try {
      const data = await doc.load();
      state = { toBuy: data.toBuy, purchased: data.purchased, categories: data.categories };
      loaded = true;
      $('#loading').hidden = true;
      $('#app-main').hidden = false;
      $('#user-bar').hidden = false;
      $('#open-categories').hidden = false;
      render();
    } catch (error) {
      $('#loading').textContent = `食料品を読み込めませんでした（${error.message}）。再読み込みしてください。`;
    }
    document.body.dataset.serviceReady = 'true';
  },
  onSignedOut(message) {
    if (message) $('#loading').textContent = message;
    document.body.dataset.serviceReady = 'true';
  },
});
