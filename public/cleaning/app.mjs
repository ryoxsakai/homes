// Homes 掃除: places to clean, how often, and when each was last done.
// Ported from ryoxsakai/cleaning-checker; saved as one household document (/api/cleaning).
import { watchAuth, signOutUser } from '../shared/auth.js?v=14';
import { $, esc, collator, today, addDays, daysBetween, shortDay, dueLabel, toast,
  createDocument, openDialog, wireDialogs, categoryManager, categoryOptions } from '../shared/homes-doc.mjs?v=1';

const PREFS_KEY = 'homes-cleaning-view';
let state = { items: [], categories: [] };
let loaded = false;
const ui = { show: 'all', category: '*', sort: 'due', addCategory: null };
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  if (['all', 'due'].includes(saved?.show)) ui.show = saved.show;
  if (['due', 'due-desc', 'place'].includes(saved?.sort)) ui.sort = saved.sort;
  if (typeof saved?.category === 'string' && saved.category.length <= 50) ui.category = saved.category;
  if (typeof saved?.addCategory === 'string' && saved.addCategory.length <= 50) ui.addCategory = saved.addCategory;
} catch {}
function remember() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(ui)); } catch {}
}
const validCategory = category => category === '' || state.categories.includes(category);
function validateCategories() {
  const previous = [ui.category, ui.addCategory];
  if (ui.category !== '*' && !validCategory(ui.category)) ui.category = '*';
  if (!validCategory(ui.addCategory)) ui.addCategory = null;
  if (ui.category !== previous[0] || ui.addCategory !== previous[1]) remember();
}

const doc = createDocument('/api/cleaning', {
  render: () => render(),
  // Keep who cleaned last (decided by the server) without disturbing newer edits.
  onSaved(saved) {
    const byId = new Map(saved.items.map(i => [i.id, i]));
    for (const item of state.items) {
      const persisted = byId.get(item.id);
      if (persisted && persisted.lastCleaned === item.lastCleaned) Object.assign(item, { lastCleanedBy: persisted.lastCleanedBy, history: persisted.history });
    }
  },
});
const save = (message, undo) => doc.save(structuredClone({ items: state.items, categories: state.categories }), message, undo);

const dueDay = item => addDays(item.lastCleaned, item.frequency);
const daysLeft = item => daysBetween(today(), dueDay(item));
const sorters = {
  due: (a, b) => dueDay(a).localeCompare(dueDay(b)) || collator.compare(a.place, b.place),
  'due-desc': (a, b) => dueDay(b).localeCompare(dueDay(a)) || collator.compare(a.place, b.place),
  place: (a, b) => collator.compare(a.place, b.place),
};
const visible = () => state.items
  .filter(i => (ui.show === 'all' || daysLeft(i) <= 0) && (ui.category === '*' || i.category === ui.category))
  .sort(sorters[ui.sort]);

// ─── Render ──────────────────────────────────────────────────────────
const CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

function render() {
  if (!loaded) return;
  validateCategories();
  const over = state.items.filter(i => daysLeft(i) < 0).length;
  const due = state.items.filter(i => daysLeft(i) <= 0).length;
  $('#summary').innerHTML = [`${state.items.length}か所`, over ? `<strong>期限切れ ${over}か所</strong>` : '',
    due - over ? `今日まで ${due - over}か所` : ''].filter(Boolean).join('・');
  $('#count-all').textContent = state.items.length;
  $('#count-due').textContent = due;
  for (const b of document.querySelectorAll('[data-show]')) b.setAttribute('aria-pressed', String(b.dataset.show === ui.show));
  ui.category = categoryOptions($('#filter-category'), state.categories, ui.category, { any: 'すべてのカテゴリ' });
  $('#filter-category').classList.toggle('is-filtered', ui.category !== '*');
  $('#sort').value = ui.sort;

  const items = visible();
  $('#item-list').innerHTML = items.map(item => {
    const left = daysLeft(item);
    const due = dueLabel(left, 1);
    const ratio = Math.min(1, Math.max(0, daysBetween(item.lastCleaned, today()) / item.frequency));
    return `<li class="homes-row${left < 0 ? ' is-overdue' : ''}">
      <button type="button" class="homes-row-main" data-edit="${esc(item.id)}">
        <span class="homes-row-title">${esc(item.place)}</span>
        <span class="homes-row-meta">
          ${item.category ? `<span class="homes-chip">${esc(item.category)}</span>` : ''}
          <span>${item.frequency}日ごと</span>
          <span>前回 ${shortDay(item.lastCleaned)}${item.lastCleanedBy ? `（${esc(item.lastCleanedBy)}）` : ''}</span>
        </span>
      </button>
      <span class="homes-row-side">
        <span class="homes-due" data-state="${due.state}">${due.text}</span>
        <span class="homes-meter" data-state="${due.state}" aria-hidden="true"><span style="width:${Math.round(ratio * 100)}%"></span></span>
      </span>
      <button type="button" class="homes-check homes-check-labelled" data-done="${esc(item.id)}" aria-label="「${esc(item.place)}」の掃除を完了" title="今日掃除した">
        <span>${CHECK}</span>完了
      </button>
    </li>`;
  }).join('');
  $('#item-list').hidden = items.length === 0;
  document.querySelector('.homes-list-foot').hidden = items.length < 2;
  $('#empty').hidden = items.length > 0;
  $('#empty-text').textContent = !state.items.length ? 'まだ掃除場所がありません。場所と頻度を登録すると、次にいつ掃除するかが分かります。'
    : ui.show === 'due' ? '今日までに掃除する場所はありません' : 'このカテゴリの場所はありません';
  $('#empty-add').hidden = state.items.length > 0;
  $('#import-legacy').hidden = state.items.length > 0;
}

// ─── Actions ─────────────────────────────────────────────────────────
function complete(ids, message) {
  const day = today();
  const before = state.items.filter(i => ids.includes(i.id)).map(i => [i, i.lastCleaned, i.lastCleanedBy]);
  if (!before.length) return;
  for (const [item] of before) item.lastCleaned = day;
  save(message, () => {
    for (const [item, lastCleaned, by] of before) { item.lastCleaned = lastCleaned; item.lastCleanedBy = by; }
    save('元に戻しました');
  });
}

// ─── Add / edit dialog ───────────────────────────────────────────────
const dialog = $('#item-dialog');
const form = $('#item-form');
let editing = null;
let initial = '';
const values = () => JSON.stringify([form.place.value, form.category.value, form.frequency.value, form.lastCleaned.value]);

function openEditor(item) {
  editing = item;
  $('#item-title').textContent = item ? '掃除場所' : '掃除場所を追加';
  $('#save-item').textContent = item ? '保存' : '追加';
  $('#delete-item').hidden = !item;
  form.place.value = item?.place || '';
  const preset = ui.addCategory ?? (state.categories[0] ?? '');
  categoryOptions(form.category, state.categories, item ? item.category : preset);
  form.frequency.value = item?.frequency || 7;
  form.lastCleaned.value = item?.lastCleaned || today();
  form.lastCleaned.max = today();
  $('#item-meta').textContent = item?.lastCleanedBy ? `前回は${item.lastCleanedBy}が掃除しました` : '';
  initial = values();
  if (!dialog.open) openDialog(dialog);
  (item ? form.frequency : form.place).focus();
}
window.homesQuickAdd = () => openEditor(null);

const clampFrequency = v => Math.min(365, Math.max(1, Number.parseInt(v, 10) || 1));
for (const button of form.querySelectorAll('[data-step]')) {
  button.addEventListener('click', () => { form.frequency.value = clampFrequency(Number(form.frequency.value) + Number(button.dataset.step)); });
}
for (const button of form.querySelectorAll('[data-frequency]')) {
  button.addEventListener('click', () => { form.frequency.value = button.dataset.frequency; });
}

form.category.addEventListener('change', () => {
  if (!dialog.open || editing) return;
  ui.addCategory = form.category.value;
  remember();
});

form.addEventListener('submit', event => {
  event.preventDefault();
  const place = form.place.value.trim();
  if (!place) { toast('場所を入力してください'); form.place.focus(); return; }
  if (!form.lastCleaned.value) { toast('最後に掃除した日を入力してください'); form.lastCleaned.focus(); return; }
  if (form.lastCleaned.value > today()) { toast('最後に掃除した日は今日以前にしてください'); form.lastCleaned.focus(); return; }
  const fields = { place: place.slice(0, 100), category: form.category.value, frequency: clampFrequency(form.frequency.value), lastCleaned: form.lastCleaned.value };
  if (editing) Object.assign(editing, fields);
  else {
    if (state.items.length >= 500) { toast('掃除場所は500か所までです'); return; }
    state.items.push({ id: crypto.randomUUID(), ...fields, lastCleanedBy: null, history: [] });
    ui.addCategory = fields.category;
    remember();
  }
  initial = values();
  dialog.close();
  save(editing ? '保存しました' : `「${fields.place}」を追加しました`);
});

$('#delete-item').addEventListener('click', () => {
  if (!editing || !confirm(`「${editing.place}」を削除しますか？`)) return;
  const item = editing, index = state.items.indexOf(item);
  state.items.splice(index, 1);
  initial = values();
  dialog.close();
  save('削除しました', () => { state.items.splice(index, 0, item); save('元に戻しました'); });
});

wireDialogs(d => d === dialog && values() !== initial);

const categories = categoryManager({
  dialog: $('#category-dialog'),
  get: () => state.categories,
  set(names, change) {
    state.categories = names;
    if (change) for (const item of state.items) if (item.category === change.from) item.category = change.to;
    if (change) {
      if (ui.category === change.from) ui.category = change.to || '*';
      if (ui.addCategory === change.from) ui.addCategory = change.to || null;
      remember();
    }
  },
  countFor: name => state.items.filter(i => i.category === name).length,
  onChange: () => save(),
});

// One-time import from the old 掃除チェッカー (its shared Firebase data), only into an
// empty list. The server does the import, so imported places are never credited to anyone.
async function importLegacy() {
  const button = $('#import-legacy');
  if (doc.busy) { toast('保存が終わってからもう一度お試しください'); return; }
  button.disabled = true;
  try {
    const call = async init => {
      const response = await fetch(init ? '/api/cleaning/import' : '/api/cleaning/legacy', { cache: 'no-store', credentials: 'same-origin', ...init });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw Error(data?.error || `読み込めませんでした (${response.status})`);
      return data;
    };
    const preview = await call();
    if (!preview.items.length) { toast('以前の掃除チェッカーに取り込める場所はありませんでした'); return; }
    if (!confirm(`以前の掃除チェッカーから${preview.items.length}か所を取り込みますか？`)) return;
    const saved = await call({ method: 'POST' });
    doc.adopt(saved);
    state = { items: saved.items, categories: saved.categories };
    render();
    toast(`${saved.items.length}か所を取り込みました`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────
$('#item-list').addEventListener('click', event => {
  const done = event.target.closest('[data-done]');
  if (done) {
    const item = state.items.find(i => i.id === done.dataset.done);
    if (item) complete([item.id], `「${item.place}」の掃除を完了しました`);
    return;
  }
  const edit = event.target.closest('[data-edit]');
  const item = edit && state.items.find(i => i.id === edit.dataset.edit);
  if (item) openEditor(item);
});
$('#complete-all').addEventListener('click', () => {
  const items = visible();
  if (!items.length || !confirm(`表示中の${items.length}か所をすべて「今日掃除した」にしますか？`)) return;
  complete(items.map(i => i.id), `${items.length}か所を完了にしました`);
});
for (const button of document.querySelectorAll('[data-show]')) {
  button.addEventListener('click', () => { ui.show = button.dataset.show; remember(); render(); });
}
$('#filter-category').addEventListener('change', event => { ui.category = event.target.value; remember(); render(); });
$('#sort').addEventListener('change', event => { ui.sort = event.target.value; remember(); render(); });
for (const id of ['#open-add', '#menu-add', '#empty-add']) $(id).addEventListener('click', () => openEditor(null));
$('#open-categories').addEventListener('click', () => categories.open());
$('#menu-list').addEventListener('click', () => scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
$('#import-legacy').addEventListener('click', importLegacy);
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
      state = { items: data.items, categories: data.categories };
      loaded = true;
      $('#loading').hidden = true;
      $('#app-main').hidden = false;
      $('#user-bar').hidden = false;
      $('#open-categories').hidden = false;
      render();
    } catch (error) {
      $('#loading').textContent = `掃除リストを読み込めませんでした（${error.message}）。再読み込みしてください。`;
    }
    document.body.dataset.serviceReady = 'true';
  },
  onSignedOut(message) {
    if (message) $('#loading').textContent = message;
    document.body.dataset.serviceReady = 'true';
  },
});
