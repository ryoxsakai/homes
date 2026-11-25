// Shared client helpers for the 食料品 and 掃除 pages: one revisioned household
// document per app (same contract as 本棚), toasts with undo, native dialogs, the
// category manager and local-date helpers.
export const $ = selector => document.querySelector(selector);
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

// ─── Dates: the family's own calendar day, not UTC ───────────────────
const pad = n => String(n).padStart(2, '0');
export const dayOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const today = () => dayOf(new Date());
export const parseDay = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (day, n) => { const d = parseDay(day); d.setDate(d.getDate() + n); return dayOf(d); };
export const daysBetween = (from, to) => Math.round((parseDay(to) - parseDay(from)) / 86400000);
export const shortDay = day => { const d = parseDay(day); return `${d.getMonth() + 1}/${d.getDate()}`; };
export const longDay = day => { const d = parseDay(day); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };

// "あと3日" / "今日まで" / "2日超過" with a state used for colour.
export function dueLabel(daysLeft, soonWithin = 3) {
  if (daysLeft < 0) return { text: `${-daysLeft}日超過`, state: 'over' };
  if (daysLeft === 0) return { text: '今日まで', state: 'today' };
  return { text: `あと${daysLeft}日`, state: daysLeft <= soonWithin ? 'soon' : 'ok' };
}

// ─── Toast (with an optional undo action) ────────────────────────────
export function toast(message, undo) {
  const box = $('#toast');
  // A modal dialog sits in the top layer, so the toast must live inside it to be seen.
  const host = document.querySelector('dialog[open]') || document.body;
  if (box.parentElement !== host) host.append(box);
  box.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }));
  if (undo) {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: '元に戻す' });
    button.addEventListener('click', () => { box.hidden = true; undo(); });
    box.append(button);
  }
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, undo ? 5000 : 2600);
}

// ─── Server document with revision (409 on a stale screen) ───────────
export function createDocument(path, { onSaved, render }) {
  let revision = 0, queue = Promise.resolve(), pending = 0, broken = false;
  async function api(init) {
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...init });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) throw Object.assign(Error(body?.error || `通信に失敗しました (${response.status})`), { status: response.status });
    return body;
  }
  window.addEventListener('beforeunload', event => {
    if (pending || broken) { event.preventDefault(); event.returnValue = ''; }
  });
  return {
    async load() {
      const data = await api();
      revision = data.revision;
      return data;
    },
    // Saves a snapshot of the whole document after each change, one request at a time.
    save(snapshot, message, undo) {
      pending++;
      $('#save-status').textContent = '保存中…';
      queue = queue.then(async () => {
        if (broken) return;
        try {
          const saved = await api({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...snapshot, revision }) });
          revision = saved.revision;
          onSaved?.(saved);
          if (message) toast(message, undo);
        } catch (error) {
          broken = true;
          $('#save-status').innerHTML = `${esc(error.message)}。<button type="button" class="homes-link-btn" id="reload">再読み込み</button>`;
          $('#reload').addEventListener('click', () => location.reload());
        }
      }).finally(() => {
        pending--;
        if (!pending && !broken) $('#save-status').textContent = '';
        render();
      });
      render();
    },
    get busy() { return pending > 0 || broken; },
  };
}

// ─── Dialogs: Esc / ✕ / キャンセル, focus returns to the opener ────────
let returnFocus = null;
export function openDialog(dialog) {
  returnFocus = document.activeElement;
  dialog.showModal();
}
export function wireDialogs(isDirty = () => false) {
  for (const dialog of document.querySelectorAll('dialog')) {
    const close = () => { if (!isDirty(dialog) || confirm('入力した内容を破棄しますか？')) dialog.close(); };
    dialog.addEventListener('click', event => { if (event.target.closest('[data-close]')) close(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => returnFocus?.focus?.({ preventScroll: true }));
  }
}

// ─── Category manager (add, rename, reorder, delete) ─────────────────
export function categoryManager({ dialog, get, set, countFor, onChange, label = 'カテゴリ' }) {
  const list = dialog.querySelector('.homes-manage-list');
  const form = dialog.querySelector('.homes-manage-add');
  const render = () => {
    const names = get();
    list.innerHTML = names.map((name, i) => `<li>
      <span class="homes-manage-name">${esc(name)}<small>${countFor(name)}件</small></span>
      <button type="button" class="homes-icon-btn" data-move="${i}" aria-label="${esc(name)}を上へ" ${i ? '' : 'disabled'}>↑</button>
      <button type="button" class="homes-icon-btn" data-rename="${i}" aria-label="${esc(name)}の名前を変更">✎</button>
      <button type="button" class="homes-icon-btn" data-remove="${i}" aria-label="${esc(name)}を削除">🗑</button>
    </li>`).join('') || '<li class="homes-manage-empty">まだありません</li>';
  };
  form.addEventListener('submit', event => {
    event.preventDefault();
    const input = form.querySelector('input');
    const name = input.value.trim().slice(0, 50);
    if (!name) return;
    const names = get();
    if (names.includes(name)) { toast(`同じ${label}があります`); return; }
    if (names.length >= 200) { toast(`${label}は200件までです`); return; }
    set([...names, name], null);
    input.value = '';
    render();
    onChange();
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const names = [...get()];
    if (button.dataset.move) {
      const i = Number(button.dataset.move);
      [names[i - 1], names[i]] = [names[i], names[i - 1]];
      set(names, null);
    } else if (button.dataset.rename) {
      const i = Number(button.dataset.rename), old = names[i];
      const name = (prompt(`${label}の新しい名前`, old) || '').trim().slice(0, 50);
      if (!name || name === old) return;
      if (names.includes(name)) { toast(`同じ${label}があります`); return; }
      names[i] = name;
      set(names, { from: old, to: name });
    } else if (button.dataset.remove) {
      const i = Number(button.dataset.remove), old = names[i];
      const count = countFor(old);
      if (!confirm(count ? `「${old}」を削除しますか？ ${count}件は「未分類」になります。` : `「${old}」を削除しますか？`)) return;
      names.splice(i, 1);
      set(names, { from: old, to: '' });
    }
    render();
    onChange();
  });
  return { open() { render(); openDialog(dialog); } };
}

// Fills a category <select>; '' is 未分類.
export function categoryOptions(select, names, value, { any } = {}) {
  select.innerHTML = (any ? `<option value="*">${esc(any)}</option>` : '') +
    names.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('') + '<option value="">未分類</option>';
  select.value = [...select.options].some(o => o.value === value) ? value : (any ? '*' : names[0] ?? '');
  return select.value;
}
