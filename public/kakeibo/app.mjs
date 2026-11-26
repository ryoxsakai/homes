// Homes 家計: a rough, hand-entered picture of household spending.
// 固定費 are standing costs (monthly, or bimonthly / yearly shown per month); the other tabs are
// dated entries listed by month. Saved as one household document (/api/kakeibo).
import { watchAuth, signOutUser } from '../shared/auth.js?v=14';
import { $, esc, collator, today, dayOf, parseDay, toast, createDocument, openDialog, wireDialogs } from '../shared/homes-doc.mjs?v=1';
import { palette, colorValue, isHexColor } from '../todo/model.mjs';

const TABS = {
  fixed: { label: '固定費', name: '項目', placeholder: '家賃・通信費など' },
  eatout: { label: '外食', name: '店名', placeholder: '店名' },
  home: { label: '内食・中食', name: 'スーパー・お店', placeholder: 'スーパー・お店' },
  conbini: { label: 'コンビニ', name: '店名', placeholder: '店名' },
  living: { label: '生活・雑貨', name: '内容', placeholder: '服・マッサージ' },
};
const KINDS = ['eatout', 'home', 'conbini', 'living'];
const PREFS_KEY = 'homes-kakeibo-view';
const yen = n => `¥${Math.round(n).toLocaleString('ja-JP')}`;
const monthOf = day => day.slice(0, 7);
const monthLabel = month => `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`;
const shiftMonth = (month, n) => { const d = parseDay(month + '-01'); d.setMonth(d.getMonth() + n); return dayOf(d).slice(0, 7); };
// Bimonthly (隔月) and yearly costs count toward each month as their monthly share.
const CYCLES = { monthly: { label: '毎月', months: 1 }, bimonthly: { label: '隔月', months: 2 }, yearly: { label: '年払い', months: 12 } };
const monthly = f => f.amount / (CYCLES[f.cycle]?.months ?? 1);

let state = { fixed: [], entries: [], tags: [] };
let loaded = false;
// The add form starts closed; ＋ opens and closes it. Tags chosen there stay for the next entry.
const ui = { tab: 'eatout', month: monthOf(today()), tag: '', review: false, addOpen: false };
const addTags = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  if (Object.hasOwn(TABS, saved.tab)) ui.tab = saved.tab;
  if (typeof saved.tag === 'string' && saved.tag.length <= 120) ui.tag = saved.tag;
  if (saved.review === true) ui.review = true;
} catch {}
const remember = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ tab: ui.tab, tag: ui.tag, review: ui.review })); } catch {} };

// ─── Tags (colours from the ToDo palette, a custom colour, or none) ───
const tagById = id => state.tags.find(t => t.id === id);
const dot = color => color ? `<i class="kakeibo-dot" style="--dot:${colorValue(color)}" aria-hidden="true"></i>` : '<i class="kakeibo-dot is-none" aria-hidden="true"></i>';
const tagChips = ids => ids.map(tagById).filter(Boolean).map(t => `<span class="kakeibo-tag">${dot(t.color)}${esc(t.name)}</span>`).join('');
function tagPicker(container, selected) {
  container.innerHTML = state.tags.map(t =>
    `<button type="button" data-tag="${esc(t.id)}" aria-pressed="${selected.has(t.id)}">${dot(t.color)}${esc(t.name)}</button>`).join('');
}
const pickerToggle = (container, selected) => container.addEventListener('click', event => {
  const button = event.target.closest('[data-tag]');
  if (!button) return;
  const id = button.dataset.tag;
  if (selected.has(id)) selected.delete(id); else if (selected.size < 10) selected.add(id); else toast('タグは1件に10個までです');
  button.setAttribute('aria-pressed', String(selected.has(id)));
});
const FLAG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>';
const matches = item => (!ui.tag || (item.tags || []).includes(ui.tag)) && (!ui.review || item.review);
const filtered = () => !!ui.tag || ui.review;

const doc = createDocument('/api/kakeibo', {
  render: () => render(),
  // Keep who entered what (decided by the server) without disturbing newer edits.
  onSaved(saved) {
    const byId = new Map([...saved.fixed, ...saved.entries].map(i => [i.id, i]));
    for (const f of state.fixed) if (byId.has(f.id)) f.addedBy = byId.get(f.id).addedBy;
    for (const e of state.entries) if (byId.has(e.id)) e.by = byId.get(e.id).by;
  },
});
const save = (message, undo) => doc.save(structuredClone({ fixed: state.fixed, entries: state.entries, tags: state.tags }), message, undo);

// "1,200" "１２００" "¥1200円" → 1200. Rough amounts are the point, so no decimals.
function parseYen(text, min) {
  const digits = String(text).normalize('NFKC').replace(/[,\s¥￥円]/g, '');
  if (!/^\d{1,9}$/.test(digits)) return null;
  const n = Number(digits);
  return n >= min && n <= 100_000_000 ? n : null;
}

// ─── Totals ──────────────────────────────────────────────────────────
const inMonth = (kind, month = ui.month) => state.entries.filter(e => e.kind === kind && monthOf(e.date) === month);
const fixedTotal = () => state.fixed.reduce((sum, f) => sum + monthly(f), 0);
const tabTotal = (tab, month = ui.month) => tab === 'fixed' ? fixedTotal() : inMonth(tab, month).reduce((s, e) => s + e.amount, 0);

// ─── Render ──────────────────────────────────────────────────────────
function render() {
  if (!loaded) return;
  const variable = KINDS.reduce((s, k) => s + tabTotal(k), 0);
  const total = variable + fixedTotal();
  const people = new Map();
  for (const e of state.entries) if (monthOf(e.date) === ui.month) people.set(e.by || '記録なし', (people.get(e.by || '記録なし') || 0) + e.amount);
  $('#summary').textContent = `${monthLabel(ui.month)}の合計 ${yen(total)}（固定費 ${yen(fixedTotal())}・やりくり ${yen(variable)}）`;
  $('#month-label').textContent = monthLabel(ui.month);
  $('#this-month').hidden = ui.month === monthOf(today());
  $('#month-total').innerHTML = people.size
    ? `入力した人：${[...people].sort((a, b) => b[1] - a[1]).map(([who, sum]) => `${esc(who)} <b>${yen(sum)}</b>`).join('・')}` : '';
  for (const button of document.querySelectorAll('[data-tab]')) {
    const selected = button.dataset.tab === ui.tab;
    button.id = `tab-${button.dataset.tab}`;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.querySelector('small').textContent = yen(tabTotal(button.dataset.tab));
  }
  $('#panel').setAttribute('aria-labelledby', `tab-${ui.tab}`);
  const info = TABS[ui.tab];
  const fixed = ui.tab === 'fixed';
  $('#add-form').classList.toggle('is-fixed', fixed);
  $('#add-name').placeholder = info.placeholder;
  $('#add-name-label').textContent = info.name;
  $('#open-add-label').textContent = ui.addOpen ? '入力欄を閉じる' : fixed ? '固定費を追加' : `${info.label}を記録`;
  $('#name-options').innerHTML = suggestions(ui.tab).map(n => `<option value="${esc(n)}">`).join('');
  // Filters
  if (ui.tag && !tagById(ui.tag)) ui.tag = '';
  const tagSelect = $('#filter-tag');
  tagSelect.innerHTML = '<option value="">タグ</option>' + state.tags.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  tagSelect.value = ui.tag;
  tagSelect.classList.toggle('is-filtered', !!ui.tag);
  tagSelect.closest('label').hidden = state.tags.length === 0;
  $('#filter-review').setAttribute('aria-pressed', String(ui.review));
  $('#review-count').textContent = [...state.fixed, ...state.entries.filter(e => monthOf(e.date) === ui.month)].filter(i => i.review).length;
  // Add form (closed until ＋)
  $('#add-form').hidden = !ui.addOpen;
  for (const button of [$('#open-add'), $('#menu-add')]) button.setAttribute('aria-expanded', String(ui.addOpen));
  $('#menu-add').setAttribute('aria-label', ui.addOpen ? '入力欄を閉じる' : '入力欄を開く');
  for (const id of addTags) if (!tagById(id)) addTags.delete(id);
  tagPicker($('#add-tags'), addTags);
  if (fixed) renderFixed(); else renderEntries();
}

const rowExtras = item => `${item.review ? '<span class="kakeibo-review-badge">見直し</span>' : ''}${tagChips(item.tags || [])}`;
const reviewToggle = (item, name) => `<button type="button" class="kakeibo-review-toggle" data-review="${esc(item.id)}" aria-pressed="${!!item.review}" aria-label="「${esc(name)}」を見直し対象${item.review ? 'から外す' : 'にする'}" title="見直し対象">${FLAG}</button>`;

// Names used before in this tab, most frequent first, for quick re-entry.
function suggestions(tab) {
  const counts = new Map();
  for (const name of tab === 'fixed' ? state.fixed.map(f => f.name) : state.entries.filter(e => e.kind === tab).map(e => e.place))
    counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0])).slice(0, 30).map(([n]) => n);
}

function renderFixed() {
  const items = state.fixed.filter(matches).sort((a, b) => monthly(b) - monthly(a) || collator.compare(a.name, b.name));
  const shown = items.reduce((sum, f) => sum + monthly(f), 0);
  $('#tab-note').innerHTML = filtered()
    ? (items.length ? `絞り込み中：月あたり <b>${yen(shown)}</b>（${items.length}件）／固定費全体 ${yen(fixedTotal())}` : '')
    : items.length ? `毎月の固定費は約 <b>${yen(fixedTotal())}</b>（隔月は2、年払いは12で割って計算）` : '';
  $('#list').innerHTML = items.map(f => `<li class="homes-row${f.review ? ' is-review' : ''}">
    <button type="button" class="homes-row-main" data-edit="${esc(f.id)}">
      <span class="homes-row-title">${esc(f.name)}</span>
      <span class="homes-row-meta">
        <span class="homes-chip">${f.cycle === 'monthly' ? '毎月' : `${CYCLES[f.cycle].label} ${yen(f.amount)}`}</span>
        ${rowExtras(f)}
        ${f.memo ? `<span>${esc(f.memo)}</span>` : ''}
        ${f.addedBy ? `<span>${esc(f.addedBy)}が登録</span>` : ''}
      </span>
    </button>
    <span class="kakeibo-amount">${yen(monthly(f))}${f.cycle === 'monthly' ? '' : '<small>月あたり</small>'}</span>
    ${reviewToggle(f, f.name)}
  </li>`).join('');
  finish(items.length, filtered() ? '条件に合う固定費はありません。' : '固定費はまだありません。＋から、家賃・通信費・保険など毎月（または隔月・毎年）かかるものを登録しましょう。');
}

function renderEntries() {
  const items = inMonth(ui.tab).filter(matches).sort((a, b) => b.date.localeCompare(a.date) || 0);
  const count = items.length;
  const shown = items.reduce((sum, e) => sum + e.amount, 0);
  $('#tab-note').innerHTML = !count ? ''
    : filtered() ? `絞り込み中：<b>${yen(shown)}</b>（${count}件）／${monthLabel(ui.month)}の${TABS[ui.tab].label}全体 ${yen(tabTotal(ui.tab))}`
    : `${monthLabel(ui.month)}の${TABS[ui.tab].label}：<b>${yen(tabTotal(ui.tab))}</b>（${count}件）`;
  $('#list').innerHTML = items.map(e => `<li class="homes-row${e.review ? ' is-review' : ''}">
    <button type="button" class="homes-row-main" data-edit="${esc(e.id)}">
      <span class="homes-row-title">${esc(e.place)}</span>
      <span class="homes-row-meta">
        <span>${Number(e.date.slice(5, 7))}/${Number(e.date.slice(8))}</span>
        ${e.by ? `<span>${esc(e.by)}</span>` : ''}
        ${rowExtras(e)}
        ${e.memo ? `<span>${esc(e.memo)}</span>` : ''}
      </span>
    </button>
    <span class="kakeibo-amount">${yen(e.amount)}</span>
    ${reviewToggle(e, e.place)}
  </li>`).join('');
  finish(count, filtered() ? '条件に合う記録はありません。' : `${monthLabel(ui.month)}の${TABS[ui.tab].label}はまだありません。＋から記録できます。`);
}

function finish(count, emptyText) {
  $('#list').hidden = count === 0;
  $('#empty').hidden = count > 0;
  $('#empty-text').textContent = emptyText;
}

// A new entry goes on today when viewing this month; otherwise on a day inside the viewed month.
function defaultDay() {
  const now = today();
  if (monthOf(now) === ui.month) return now;
  if (ui.month < monthOf(now)) { const d = parseDay(shiftMonth(ui.month, 1) + '-01'); d.setDate(0); return dayOf(d); }
  return ui.month + '-01';
}

// ─── Add ─────────────────────────────────────────────────────────────
$('#add-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#add-name').value.trim().slice(0, 100);
  const fixed = ui.tab === 'fixed';
  const amount = parseYen($('#add-amount').value, fixed ? 0 : 1);
  if (!name) { toast(`${TABS[ui.tab].name}を入力してください`); $('#add-name').focus(); return; }
  if (amount === null) { toast('金額を数字で入力してください'); $('#add-amount').focus(); return; }
  if (fixed) {
    if (state.fixed.length >= 200) { toast('固定費は200件までです'); return; }
    state.fixed.push({ id: crypto.randomUUID(), name, amount, cycle: $('#add-cycle').value, memo: '', addedBy: null, tags: [...addTags], review: false });
  } else {
    if (state.entries.length >= 10000) { toast('記録は10000件までです'); return; }
    state.entries.push({ id: crypto.randomUUID(), kind: ui.tab, date: defaultDay(), place: name, amount, memo: '', by: null, tags: [...addTags], review: false });
  }
  save(`「${name}」${yen(amount)}を記録しました`);
  $('#add-name').value = '';
  $('#add-amount').value = '';
  $('#add-name').focus();
});
// Choosing a name from the list jumps straight to the amount.
$('#add-name').addEventListener('change', () => { if ($('#add-name').value.trim()) $('#add-amount').focus(); });

// ─── Edit dialog ─────────────────────────────────────────────────────
const dialog = $('#item-dialog');
const form = $('#item-form');
let editing = null;
let initial = '';
const editTags = new Set();
const values = () => JSON.stringify([form.kind.value, form.name.value, form.amount.value, form.date.value, form.cycle.value, form.memo.value, [...editTags].sort(), form.review.checked]);

function openEditor(id) {
  const fixed = state.fixed.find(f => f.id === id);
  editing = fixed || state.entries.find(e => e.id === id);
  if (!editing) return;
  for (const el of form.querySelectorAll('[data-for="entry"]')) el.hidden = !!fixed;
  for (const el of form.querySelectorAll('[data-for="fixed"]')) el.hidden = !fixed;
  $('#item-title').textContent = fixed ? '固定費' : TABS[editing.kind].label;
  $('#name-label').textContent = fixed ? '項目' : TABS[editing.kind].name;
  form.kind.value = fixed ? 'eatout' : editing.kind;
  form.name.value = fixed ? editing.name : editing.place;
  form.amount.value = String(editing.amount);
  form.date.value = fixed ? '' : editing.date;
  form.cycle.value = fixed ? editing.cycle : 'monthly';
  form.memo.value = editing.memo || '';
  editTags.clear();
  for (const id of editing.tags || []) if (tagById(id)) editTags.add(id);
  tagPicker($('#edit-tags'), editTags);
  $('#edit-tags').closest('.homes-field').hidden = state.tags.length === 0;
  form.review.checked = !!editing.review;
  const by = fixed ? editing.addedBy : editing.by;
  $('#item-meta').textContent = by ? `${by}が記録` : '記録した人：記録なし';
  initial = values();
  openDialog(dialog);
}
form.kind.addEventListener('change', () => { $('#name-label').textContent = TABS[form.kind.value].name; });

form.addEventListener('submit', event => {
  event.preventDefault();
  const fixed = state.fixed.includes(editing);
  const name = form.name.value.trim().slice(0, 100);
  const amount = parseYen(form.amount.value, fixed ? 0 : 1);
  if (!name) { toast('名前を入力してください'); form.name.focus(); return; }
  if (amount === null) { toast('金額を数字で入力してください'); form.amount.focus(); return; }
  const common = { amount, memo: form.memo.value.trim().slice(0, 200), tags: [...editTags], review: form.review.checked };
  if (fixed) Object.assign(editing, { name, cycle: form.cycle.value, ...common });
  else {
    if (!form.date.value) { toast('日付を入力してください'); form.date.focus(); return; }
    Object.assign(editing, { kind: form.kind.value, place: name, date: form.date.value, ...common });
  }
  initial = values();
  dialog.close();
  save('保存しました');
});

$('#delete-item').addEventListener('click', () => {
  if (!editing) return;
  const fixed = state.fixed.includes(editing);
  const name = fixed ? editing.name : editing.place;
  if (!confirm(`「${name}」を削除しますか？`)) return;
  const list = fixed ? state.fixed : state.entries;
  const item = editing, index = list.indexOf(item);
  list.splice(index, 1);
  initial = values();
  dialog.close();
  save('削除しました', () => { (fixed ? state.fixed : state.entries).splice(index, 0, item); save('元に戻しました'); });
});

pickerToggle($('#add-tags'), addTags);
pickerToggle($('#edit-tags'), editTags);
wireDialogs(d => (d === dialog && values() !== initial) || (d === $('#tag-dialog') && tagFormDirty()));

// ─── Tag settings (header gear) ──────────────────────────────────────
const tagDialog = $('#tag-dialog');
let editingTag = null;
let chosenColor = null;
const COLOR_KEYS = Object.keys(palette);
function renderTagColors() {
  $('#tag-colors').innerHTML = `<button type="button" data-color="" aria-label="色なし" title="色なし" aria-pressed="${chosenColor === null}">${dot(null)}</button>` +
    COLOR_KEYS.map(key => `<button type="button" data-color="${key}" aria-label="${palette[key][0]}" title="${palette[key][0]}" aria-pressed="${chosenColor === key}">${dot(key)}</button>`).join('');
  const hex = chosenColor ? colorValue(chosenColor) : '';
  $('#tag-color-custom').value = hex || '#64748b';
  $('#tag-color-value').textContent = chosenColor && isHexColor(chosenColor) ? hex.toUpperCase() : '';
}
function renderTagList() {
  const used = id => [...state.fixed, ...state.entries].filter(i => (i.tags || []).includes(id)).length;
  $('#tag-list').innerHTML = state.tags.map(t => `<li>
    <span class="homes-manage-name">${dot(t.color)}${esc(t.name)}<small>${used(t.id)}件</small></span>
    <button type="button" class="homes-icon-btn" data-edit-tag="${esc(t.id)}" aria-label="${esc(t.name)}を編集">✎</button>
    <button type="button" class="homes-icon-btn" data-remove-tag="${esc(t.id)}" aria-label="${esc(t.name)}を削除">🗑</button>
  </li>`).join('') || '<li class="homes-manage-empty">まだタグはありません</li>';
}
function resetTagForm(tag = null) {
  editingTag = tag;
  chosenColor = tag?.color ?? null;
  $('#tag-name').value = tag?.name ?? '';
  $('#tag-form-title').textContent = tag ? `「${tag.name}」を編集` : '新しいタグ';
  $('#tag-submit').textContent = tag ? '保存' : '追加';
  $('#tag-cancel').hidden = !tag;
  renderTagColors();
}
const tagFormDirty = () => $('#tag-name').value.trim() !== (editingTag?.name ?? '') || chosenColor !== (editingTag?.color ?? null);
$('#tag-colors').addEventListener('click', event => {
  const button = event.target.closest('[data-color]');
  if (!button) return;
  chosenColor = button.dataset.color || null;
  renderTagColors();
});
$('#tag-color-custom').addEventListener('input', event => { chosenColor = event.target.value.toLowerCase(); renderTagColors(); });
$('#tag-cancel').addEventListener('click', () => resetTagForm());
$('#tag-list').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit-tag]');
  const remove = event.target.closest('[data-remove-tag]');
  if (edit) { resetTagForm(tagById(edit.dataset.editTag)); $('#tag-name').focus(); return; }
  if (!remove) return;
  const tag = tagById(remove.dataset.removeTag);
  const items = [...state.fixed, ...state.entries].filter(i => (i.tags || []).includes(tag.id));
  if (!confirm(items.length ? `タグ「${tag.name}」を削除しますか？ ${items.length}件の記録から外れます。` : `タグ「${tag.name}」を削除しますか？`)) return;
  state.tags = state.tags.filter(t => t !== tag);
  for (const item of items) item.tags = item.tags.filter(id => id !== tag.id);
  if (editingTag === tag) resetTagForm();
  renderTagList();
  save(`タグ「${tag.name}」を削除しました`);
});
$('#tag-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#tag-name').value.trim().slice(0, 30);
  if (!name) { toast('タグの名前を入力してください'); $('#tag-name').focus(); return; }
  if (state.tags.some(t => t !== editingTag && t.name === name)) { toast('同じ名前のタグがあります'); return; }
  if (editingTag) Object.assign(editingTag, { name, color: chosenColor });
  else {
    if (state.tags.length >= 50) { toast('タグは50個までです'); return; }
    state.tags.push({ id: crypto.randomUUID(), name, color: chosenColor });
  }
  save(editingTag ? `タグ「${name}」を保存しました` : `タグ「${name}」を追加しました`);
  resetTagForm();
  renderTagList();
});
$('#open-tags').addEventListener('click', () => { resetTagForm(); renderTagList(); openDialog(tagDialog); });

// ─── Wiring ──────────────────────────────────────────────────────────
function selectTab(tab, focus = false) {
  ui.tab = tab;
  remember();
  render();
  const button = $(`[data-tab="${tab}"]`);
  button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focus) button.focus();
}
const tabs = [...document.querySelectorAll('[data-tab]')];
for (const button of tabs) button.addEventListener('click', () => selectTab(button.dataset.tab));
$('.kakeibo-tabs').addEventListener('keydown', event => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const index = tabs.findIndex(b => b.dataset.tab === ui.tab);
  selectTab(tabs[(index + step + tabs.length) % tabs.length].dataset.tab, true);
});
const goMonth = month => { ui.month = month; render(); };
$('#prev-month').addEventListener('click', () => goMonth(shiftMonth(ui.month, -1)));
$('#next-month').addEventListener('click', () => goMonth(shiftMonth(ui.month, 1)));
$('#this-month').addEventListener('click', () => goMonth(monthOf(today())));
$('#menu-month').addEventListener('click', () => { goMonth(monthOf(today())); toast(`${monthLabel(ui.month)}を表示しています`); });
// ＋ toggles the add form; opening it moves the cursor to the first field.
function setAddOpen(open) {
  ui.addOpen = open;
  render();
  if (open) { $('#add-name').focus(); $('#add-form').scrollIntoView({ block: 'nearest' }); }
}
$('#open-add').addEventListener('click', () => setAddOpen(!ui.addOpen));
$('#menu-add').addEventListener('click', () => setAddOpen(!ui.addOpen));
window.homesQuickAdd = () => { if (ui.tab === 'fixed') ui.tab = 'eatout'; setAddOpen(true); };
$('#filter-tag').addEventListener('change', event => { ui.tag = event.target.value; remember(); render(); });
$('#filter-review').addEventListener('click', () => { ui.review = !ui.review; remember(); render(); });
$('#list').addEventListener('click', event => {
  const flag = event.target.closest('[data-review]');
  if (flag) {
    const item = [...state.fixed, ...state.entries].find(i => i.id === flag.dataset.review);
    if (!item) return;
    item.review = !item.review;
    const name = item.name ?? item.place;
    save(item.review ? `「${name}」を見直し対象にしました` : `「${name}」を見直し対象から外しました`);
    return;
  }
  const edit = event.target.closest('[data-edit]');
  if (edit) openEditor(edit.dataset.edit);
});
$('#menu-list').addEventListener('click', () => scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
$('#sign-out').addEventListener('click', async () => {
  if (!confirm('ログアウトしますか？')) return;
  await signOutUser();
  if (window === top) location.replace('/');
});

watchAuth({
  async onSignedIn() {
    try {
      const data = await doc.load();
      state = { fixed: data.fixed, entries: data.entries, tags: data.tags ?? [] };
      for (const item of [...state.fixed, ...state.entries]) { item.tags ??= []; item.review ??= false; }
      loaded = true;
      $('#loading').hidden = true;
      $('#app-main').hidden = false;
      $('#user-bar').hidden = false;
      $('#open-tags').hidden = false;
      render();
    } catch (error) {
      $('#loading').textContent = `家計を読み込めませんでした（${error.message}）。再読み込みしてください。`;
    }
    document.body.dataset.serviceReady = 'true';
  },
  onSignedOut(message) {
    if (message) $('#loading').textContent = message;
    document.body.dataset.serviceReady = 'true';
  },
});
