import { watchAuth, signOutUser } from '../shared/auth.js?v=14';
import { $, esc, today, daysBetween, shortDay, dueLabel, toast,
  createDocument, openDialog, wireDialogs, categoryManager, categoryOptions } from '../shared/homes-doc.mjs?v=2';
import { readGrocery, groceryItems, moveItem, swipeStep, shouldToggleBuy } from './model.mjs?v=1';

const PREFS_KEY = 'homes-grocery-inventory-view';
let state = readGrocery({ toBuy: [], purchased: [], categories: [] });
let loaded = false, editing = null, initial = '', gesture = null, delayedRender = false, suppressClick = false;
const ui = { view: 'inventory', category: null, reorder: false };
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  if (saved.view === 'buy') ui.view = 'buy';
  if (typeof saved.category === 'string' && saved.category.length <= 50) ui.category = saved.category;
  if (!localStorage.getItem(PREFS_KEY)) {
    const prior = JSON.parse(localStorage.getItem('homes-grocery-view') || '{}');
    if (typeof prior.category === 'string' && prior.category !== '*' && prior.category.length <= 50) ui.category = prior.category;
  }
} catch {}
const remember = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ view: ui.view, category: ui.category })); } catch {} };

const doc = createDocument('/api/grocery', {
  render,
  onSaved(saved) {
    const byId = new Map([...saved.toBuy, ...saved.purchased].map(item => [item.id, item]));
    for (const { item } of groceryItems(state)) {
      const persisted = byId.get(item.id);
      if (!persisted) continue;
      item.addedBy = persisted.addedBy;
      if (item.purchasedDate === persisted.purchasedDate && 'purchasedBy' in persisted) item.purchasedBy = persisted.purchasedBy;
    }
  },
});
const save = (message, undo, markPurchased) => doc.save(
  structuredClone({ ...state, ...(markPurchased ? { markPurchased } : {}) }), message, undo,
);
const editable = () => {
  if (!doc.blocked) return true;
  $('#reload')?.focus({ preventScroll: true });
  return false;
};
const byId = id => groceryItems(state).find(entry => entry.item.id === id);
const matching = rows => rows.filter(({item}) => ui.category === null || item.category === ui.category);

// Icons match the line style and size of the Homes toolbar.
const icon = path => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const cart = icon('<path d="M5 8h14l-1.5 10h-11zM8 8l4-6 4 6"/><path d="M9 13h6m-3-3v6"/>');
const purchased = icon('<path d="m5 12 5 5L19 8"/>');
const pencil = icon('<path d="m15 5 4 4M5 19l4-.8L20 7l-4-4L5 14z"/>');
const up = icon('<path d="M12 19V5m-5 5 5-5 5 5"/>');
const down = icon('<path d="M12 5v14m-5-5 5 5 5-5"/>');

const list = $('#inventory-list'), tabs = $('#category-tabs');
const expiryName = entry => entry.expiryKind === 'use-by' ? '消費期限' : '賞味期限';
const orderLabel = entry => entry.inStock ? 'ある' : 'ない';

function render() {
  if (!loaded) return;
  if (gesture) { delayedRender = true; return; }
  delayedRender = false;
  const rows = groceryItems(state);
  const buy = rows.filter(entry => entry.buyChecked);
  if (ui.category !== null && ui.category !== '' && !state.categories.includes(ui.category)) {
    ui.category = null; remember();
  }
  const active = document.activeElement;
  const focusKey = active?.dataset?.groceryFocus;
  const scrolled = tabs.scrollLeft;
  const overdue = rows.filter(e => e.inStock && e.expiryEnabled && e.item.expiryDate && e.item.expiryDate < today()).length;
  $('#summary').textContent = `在庫あり ${rows.filter(e => e.inStock).length}件・買うもの ${buy.length}件${overdue ? `・期限切れ ${overdue}件` : ''}`;
  $('#count-buy').textContent = buy.length;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === ui.view));
  const reorder = $('#reorder-items');
  reorder.hidden = ui.view !== 'inventory';
  reorder.setAttribute('aria-pressed', String(ui.reorder));
  reorder.textContent = ui.reorder ? '並べ替えを終了' : '並べ替え';
  $('#inventory-hint').textContent = ui.reorder ? '矢印で同じカテゴリ内の順番を変更します。'
    : ui.view === 'buy' ? '「購入済み」にすると在庫が「ある」になり、買うもの一覧から外れます。'
      : 'タップで「ある／ない」。右に軽くスライドすると「買う」を切り替えます。';
  const tabNames = [null, ...state.categories, ''];
  tabs.innerHTML = tabNames.map((name, i) =>
    `<button type="button" data-tab-index="${i}" data-grocery-focus="tab:${i}" aria-pressed="${name === ui.category}">${esc(name === null ? 'すべて' : name || '未分類')}</button>`).join('');
  tabs.scrollLeft = scrolled;
  const shown = matching(ui.view === 'buy' ? buy : rows);
  const groups = (ui.category === null ? [...state.categories, ''] : [ui.category])
    .map(category => [category, shown.filter(({ item }) => item.category === category)]).filter(([, items]) => items.length);
  list.innerHTML = groups.map(([category, entries]) => `
    ${ui.category === null ? `<h3 class="homes-group-title">${esc(category || '未分類')}<span class="homes-count">${entries.length}</span></h3>` : ''}
    <ul class="homes-panel grocery-items">${entries.map((entry, index) => rowMarkup(entry, index, entries)).join('')}</ul>`).join('');
  const empty = $('#inventory-empty');
  empty.hidden = shown.length > 0;
  empty.querySelector('p').textContent = ui.view === 'buy' ? 'このカテゴリに買うものはありません。'
    : 'このカテゴリに品物はありません。「品物を追加」から登録できます。';
  if (focusKey && !active.isConnected) {
    const replacement = [...document.querySelectorAll('[data-grocery-focus]')].find(el => el.dataset.groceryFocus === focusKey);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    else if (ui.reorder) reorder.focus({ preventScroll: true });
    else document.querySelector(`[data-view="${ui.view}"]`).focus({ preventScroll: true });
  }
}

function rowMarkup(entry, index, group) {
  const { item } = entry;
  const id = esc(item.id);
  const name = esc(item.name);
  const due = entry.expiryEnabled && item.expiryDate ? dueLabel(daysBetween(today(), item.expiryDate)) : null;
  const meta = item.purchasedDate ? `${shortDay(item.purchasedDate)}に購入${item.purchasedBy ? `（${esc(item.purchasedBy)}）` : ''}` : '';
  const move = (direction, off, glyph) => `<button type="button" class="homes-icon-btn grocery-tool" data-move="${direction}" data-id="${id}" data-grocery-focus="move:${direction}:${id}" aria-label="「${name}」を${direction < 0 ? '上' : '下'}へ" ${off ? 'disabled' : ''}>${glyph}</button>`;
  return `<li class="grocery-item" data-item-id="${id}">
    <div class="grocery-swipe-hint" aria-hidden="true">${cart}<span>${entry.buyChecked ? '買うを外す' : '買うに追加'}</span></div>
    <div class="grocery-row" data-stock="${entry.inStock}">
      <button type="button" class="grocery-stock" data-stock-id="${id}" data-grocery-focus="stock:${id}" aria-label="「${name}」の在庫" aria-pressed="${entry.inStock}" ${ui.reorder ? 'disabled' : ''}>
        <span class="grocery-state">${orderLabel(entry)}</span>
        <span class="grocery-copy">
          <span class="homes-row-title">${name}</span>
          ${due ? `<span class="grocery-date"> ${expiryName(entry)} ${shortDay(item.expiryDate)} <span class="homes-due" data-state="${due.state}">${due.text}</span></span>` : ''}
          ${meta ? `<span class="homes-row-meta">${meta}</span>` : ''}
        </span>
      </button>
      <div class="grocery-tools">
        ${ui.reorder ? move(-1, index === 0, up) + move(1, index === group.length - 1, down) : `
        ${ui.view === 'buy' ? `<button type="button" class="homes-icon-btn grocery-tool grocery-complete" data-purchased="${id}" data-grocery-focus="purchase:${id}" aria-label="「${name}」を購入済みにする" title="購入済み">${purchased}</button>` : ''}
        <button type="button" class="homes-icon-btn grocery-tool grocery-buy" data-buy-id="${id}" data-grocery-focus="buy:${id}" aria-pressed="${entry.buyChecked}" aria-label="「${name}」を買う" title="買う">${cart}</button>
        <button type="button" class="homes-icon-btn grocery-tool" data-edit-id="${id}" data-grocery-focus="edit:${id}" aria-label="「${name}」を編集" title="編集">${pencil}</button>`}
      </div>
    </div>
  </li>`;
}

function toggleBuy(id) {
  if (!editable()) return;
  const entry = byId(id);
  if (!entry) return;
  entry.item.buyChecked = !entry.buyChecked;
  save(entry.item.buyChecked ? '買うものに追加しました' : '買うものから外しました');
}
function markBought(id) {
  if (!editable()) return;
  const entry = byId(id);
  if (!entry || !entry.buyChecked) return;
  if (entry.bucket === 'toBuy' && state.purchased.length >= 3000) { toast('購入記録は3000件までです'); return; }
  const from = state[entry.bucket], oldIndex = from.indexOf(entry.item);
  const item = { ...entry.item, inStock: true, buyChecked: false, purchasedDate: today(), expiryDate: entry.item.expiryDate ?? null, purchasedBy: null };
  from.splice(oldIndex, 1);
  state.purchased.splice(entry.bucket === 'purchased' ? oldIndex : 0, 0, item);
  save('購入済みにしました', undefined, id);
}

const dialog = $('#item-dialog'), form = $('#item-form'), fields = form.elements;
const values = () => JSON.stringify([fields.name.value, fields.category.value, fields.inStock.checked,
  fields.buyChecked.checked, fields.expiryEnabled.checked, fields.expiryKind.value, fields.expiryDate.value, fields.purchasedDate.value]);
function syncExpiry() {
  $('#expiry-fields').hidden = !fields.expiryEnabled.checked;
  fields.expiryDate.required = fields.expiryEnabled.checked;
}
function openEditor(entry, quickBuy = false) {
  if (!loaded || !editable()) return;
  editing = entry;
  const item = entry?.item;
  $('#item-title').textContent = item ? '品物を編集' : '品物を追加';
  fields.name.value = item?.name || '';
  categoryOptions(fields.category, state.categories, item?.category ?? ui.category ?? '');
  fields.inStock.checked = entry?.inStock ?? false;
  fields.buyChecked.checked = entry?.buyChecked ?? (quickBuy || ui.view === 'buy');
  fields.expiryEnabled.checked = entry?.expiryEnabled ?? false;
  fields.expiryKind.value = entry?.expiryKind ?? 'best-before';
  fields.expiryDate.value = item?.expiryDate ?? '';
  fields.purchasedDate.value = item?.purchasedDate ?? '';
  $('#purchase-details').hidden = entry?.bucket !== 'purchased';
  $('#purchase-details').open = false;
  $('#delete-item').hidden = !item;
  $('#item-meta').textContent = [item?.addedBy && `${item.addedBy}が追加`, item?.purchasedBy && `${item.purchasedBy}が購入`].filter(Boolean).join('・');
  syncExpiry();
  initial = values();
  openDialog(dialog);
  fields.name.focus({ preventScroll: true });
}
fields.expiryEnabled.addEventListener('change', syncExpiry);
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!editable()) return;
  const name = fields.name.value.trim().slice(0, 200);
  if (!name) { toast('品名を入力してください'); fields.name.focus(); return; }
  if (fields.expiryEnabled.checked && !fields.expiryDate.value) { toast('期限日を入力してください'); fields.expiryDate.focus(); return; }
  if (editing?.bucket === 'purchased' && !fields.purchasedDate.value) {
    $('#purchase-details').open = true; toast('購入日を入力してください'); fields.purchasedDate.focus(); return;
  }
  if (!editing && state.toBuy.length >= 1000) { toast('新しく登録できる品物は1000件までです'); return; }
  const item = editing?.item ?? { id: crypto.randomUUID(), addedOn: today(), addedBy: null };
  Object.assign(item, { name, category: fields.category.value, inStock: fields.inStock.checked,
    buyChecked: fields.buyChecked.checked, expiryEnabled: fields.expiryEnabled.checked,
    expiryKind: fields.expiryKind.value, expiryDate: fields.expiryDate.value || null });
  if (editing?.bucket === 'purchased') item.purchasedDate = fields.purchasedDate.value;
  if (!editing) { state.toBuy.push(item); state.itemOrder.push(item.id); }
  initial = values(); dialog.close(); save(editing ? '保存しました' : '品物を追加しました');
});
$('#delete-item').addEventListener('click', () => {
  if (!editable() || !editing || !confirm(`「${editing.item.name}」を削除しますか？`)) return;
  const { item, bucket } = editing, gone = state[bucket];
  const index = gone.indexOf(item), order = state.itemOrder.indexOf(item.id);
  gone.splice(index, 1); state.itemOrder.splice(order, 1);
  initial = values(); dialog.close();
  save('削除しました', () => {
    if (!editable()) return;
    if (item.category && !state.categories.includes(item.category)) item.category = '';
    gone.splice(Math.min(index, gone.length), 0, item);
    state.itemOrder.splice(Math.min(order, state.itemOrder.length), 0, item.id);
    save('元に戻しました');
  });
});
wireDialogs(d => d === dialog && values() !== initial);

const categories = categoryManager({
  dialog: $('#category-dialog'), get: () => state.categories, twoWayOrder: true,
  set(names, change) {
    if (!editable()) return;
    state.categories = names;
    if (change) {
      for (const { item } of groceryItems(state)) if (item.category === change.from) item.category = change.to;
      if (ui.category === change.from) { ui.category = change.to; remember(); }
    }
  },
  countFor: name => groceryItems(state).filter(({ item }) => item.category === name).length,
  onChange: () => save(),
});

$('#open-categories').addEventListener('click', () => categories.open());
$('#manage-tabs').addEventListener('click', () => categories.open());
$('#open-add').addEventListener('click', () => openEditor(null));
$('#menu-add').addEventListener('click', () => openEditor(null));
window.homesQuickAdd = () => openEditor(null, true);
$('#menu-list').addEventListener('click', () => scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
$('#sign-out').addEventListener('click', async () => {
  if (confirm('ログアウトしますか？')) { await signOutUser(); if (window === top) location.replace('/'); }
});
$('#reorder-items').addEventListener('click', () => { ui.reorder = !ui.reorder; render(); });
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => { ui.view = button.dataset.view; ui.reorder = false; remember(); render(); });
}
tabs.addEventListener('click', event => {
  const button = event.target.closest('[data-tab-index]');
  if (!button) return;
  ui.category = [null, ...state.categories, ''][Number(button.dataset.tabIndex)];
  remember(); render();
});
list.addEventListener('click', event => {
  if (suppressClick && event.detail > 0) { suppressClick = false; event.preventDefault(); return; }
  const button = event.target.closest('button');
  if (!button || button.disabled || !editable()) return;
  if ('stockId' in button.dataset) {
    const entry = byId(button.dataset.stockId);
    if (entry) { entry.item.inStock = !entry.inStock; save(); }
  } else if ('buyId' in button.dataset) toggleBuy(button.dataset.buyId);
  else if ('purchased' in button.dataset) markBought(button.dataset.purchased);
  else if ('editId' in button.dataset) openEditor(byId(button.dataset.editId));
  else if ('move' in button.dataset && ui.reorder) {
    const entry = byId(button.dataset.id);
    if (!entry) return;
    const siblings = groceryItems(state).filter(({ item }) => item.category === entry.item.category).map(({ item }) => item.id);
    const next = moveItem(state.itemOrder, siblings, entry.item.id, Number(button.dataset.move));
    if (next) { state.itemOrder = next; save('順番を保存しました'); }
  }
});

list.addEventListener('pointerdown', event => {
  suppressClick = false;
  const button = event.target.closest('[data-stock-id]');
  if (!button || doc.blocked || ui.reorder || !event.isPrimary || event.button !== 0) return;
  const row = button.closest('.grocery-row');
  gesture = { row, button, pointerId: event.pointerId, id: button.dataset.stockId, startX: event.clientX, startY: event.clientY };
});
function measure(event) {
  const step = swipeStep(gesture, event.clientX - gesture.startX, event.clientY - gesture.startY);
  const wasHorizontal = gesture.horizontal;
  gesture = step;
  if (step.horizontal && !step.cancelled) {
    if (!wasHorizontal && !step.button.hasPointerCapture(event.pointerId)) step.button.setPointerCapture(event.pointerId);
    step.row.classList.add('is-sliding');
    step.row.closest('li').classList.toggle('is-armed', Boolean(step.armed));
    step.row.style.setProperty('--grocery-offset', `${step.offset}px`);
  }
}
document.addEventListener('pointermove', event => { if (gesture?.pointerId === event.pointerId) measure(event); });
function endGesture(event) {
  if (gesture?.pointerId !== event.pointerId) return;
  if (event.type === 'pointerup' && !gesture.cancelled) measure(event);
  const step = gesture;
  gesture = null;
  step.row.classList.remove('is-sliding');
  step.row.closest('li').classList.remove('is-armed');
  step.row.style.removeProperty('--grocery-offset');
  // Only suppress that physical gesture's click; keyboard clicks still work.
  suppressClick = Boolean(step.horizontal || step.cancelled);
  if (event.type === 'pointerup' && shouldToggleBuy(step)) toggleBuy(step.id);
  else if (delayedRender && suppressClick) render();
  else if (delayedRender) setTimeout(render, 0);
}
document.addEventListener('pointerup', endGesture);
document.addEventListener('pointercancel', endGesture);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

watchAuth({
  async onSignedIn() {
    try {
      state = readGrocery(await doc.load());
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
