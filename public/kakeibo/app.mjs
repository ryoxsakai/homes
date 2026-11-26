// Homes 家計: a rough, hand-entered picture of household spending.
// 固定費 are standing costs (monthly, or bimonthly / yearly shown per month); the other tabs are
// dated entries listed by month. Saved as one household document (/api/kakeibo).
import { watchAuth, signOutUser } from '../shared/auth.js?v=14';
import { $, esc, collator, today, dayOf, parseDay, toast, createDocument, openDialog, wireDialogs } from '../shared/homes-doc.mjs?v=1';

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

let state = { fixed: [], entries: [] };
let loaded = false;
const ui = { tab: 'eatout', month: monthOf(today()) };
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  if (Object.hasOwn(TABS, saved.tab)) ui.tab = saved.tab;
} catch {}
const remember = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ tab: ui.tab })); } catch {} };

const doc = createDocument('/api/kakeibo', {
  render: () => render(),
  // Keep who entered what (decided by the server) without disturbing newer edits.
  onSaved(saved) {
    const byId = new Map([...saved.fixed, ...saved.entries].map(i => [i.id, i]));
    for (const f of state.fixed) if (byId.has(f.id)) f.addedBy = byId.get(f.id).addedBy;
    for (const e of state.entries) if (byId.has(e.id)) e.by = byId.get(e.id).by;
  },
});
const save = (message, undo) => doc.save(structuredClone({ fixed: state.fixed, entries: state.entries }), message, undo);

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
  $('#open-add-label').textContent = fixed ? '固定費を追加' : `${info.label}を記録`;
  $('#name-options').innerHTML = suggestions(ui.tab).map(n => `<option value="${esc(n)}">`).join('');
  if (fixed) renderFixed(); else renderEntries();
}

// Names used before in this tab, most frequent first, for quick re-entry.
function suggestions(tab) {
  const counts = new Map();
  for (const name of tab === 'fixed' ? state.fixed.map(f => f.name) : state.entries.filter(e => e.kind === tab).map(e => e.place))
    counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0])).slice(0, 30).map(([n]) => n);
}

function renderFixed() {
  const items = [...state.fixed].sort((a, b) => monthly(b) - monthly(a) || collator.compare(a.name, b.name));
  $('#tab-note').innerHTML = items.length ? `毎月の固定費は約 <b>${yen(fixedTotal())}</b>（隔月は2、年払いは12で割って計算）` : '';
  $('#list').innerHTML = items.map(f => `<li class="homes-row">
    <button type="button" class="homes-row-main" data-edit="${esc(f.id)}">
      <span class="homes-row-title">${esc(f.name)}</span>
      <span class="homes-row-meta">
        <span class="homes-chip">${f.cycle === 'monthly' ? '毎月' : `${CYCLES[f.cycle].label} ${yen(f.amount)}`}</span>
        ${f.memo ? `<span>${esc(f.memo)}</span>` : ''}
        ${f.addedBy ? `<span>${esc(f.addedBy)}が登録</span>` : ''}
      </span>
    </button>
    <span class="kakeibo-amount">${yen(monthly(f))}${f.cycle === 'monthly' ? '' : '<small>月あたり</small>'}</span>
  </li>`).join('');
  finish(items.length, '固定費はまだありません。家賃・通信費・保険など、毎月（または毎年）かかるものを登録しましょう。');
}

function renderEntries() {
  const items = inMonth(ui.tab).sort((a, b) => b.date.localeCompare(a.date) || 0);
  const count = items.length;
  $('#tab-note').innerHTML = count ? `${monthLabel(ui.month)}の${TABS[ui.tab].label}：<b>${yen(tabTotal(ui.tab))}</b>（${count}件）` : '';
  $('#list').innerHTML = items.map(e => `<li class="homes-row">
    <button type="button" class="homes-row-main" data-edit="${esc(e.id)}">
      <span class="homes-row-title">${esc(e.place)}</span>
      <span class="homes-row-meta">
        <span>${Number(e.date.slice(5, 7))}/${Number(e.date.slice(8))}</span>
        ${e.by ? `<span>${esc(e.by)}</span>` : ''}
        ${e.memo ? `<span>${esc(e.memo)}</span>` : ''}
      </span>
    </button>
    <span class="kakeibo-amount">${yen(e.amount)}</span>
  </li>`).join('');
  finish(count, `${monthLabel(ui.month)}の${TABS[ui.tab].label}はまだありません。`);
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
    state.fixed.push({ id: crypto.randomUUID(), name, amount, cycle: $('#add-cycle').value, memo: '', addedBy: null });
  } else {
    if (state.entries.length >= 10000) { toast('記録は10000件までです'); return; }
    state.entries.push({ id: crypto.randomUUID(), kind: ui.tab, date: defaultDay(), place: name, amount, memo: '', by: null });
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
const values = () => JSON.stringify([form.kind.value, form.name.value, form.amount.value, form.date.value, form.cycle.value, form.memo.value]);

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
  if (fixed) Object.assign(editing, { name, amount, cycle: form.cycle.value, memo: form.memo.value.trim().slice(0, 200) });
  else {
    if (!form.date.value) { toast('日付を入力してください'); form.date.focus(); return; }
    Object.assign(editing, { kind: form.kind.value, place: name, amount, date: form.date.value, memo: form.memo.value.trim().slice(0, 200) });
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

wireDialogs(d => d === dialog && values() !== initial);

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
const focusAdd = () => { $('#add-name').focus(); $('#add-form').scrollIntoView({ block: 'nearest' }); };
$('#open-add').addEventListener('click', focusAdd);
$('#menu-add').addEventListener('click', focusAdd);
window.homesQuickAdd = () => { if (ui.tab === 'fixed') selectTab('eatout'); focusAdd(); };
$('#list').addEventListener('click', event => {
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
      state = { fixed: data.fixed, entries: data.entries };
      loaded = true;
      $('#loading').hidden = true;
      $('#app-main').hidden = false;
      $('#user-bar').hidden = false;
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
