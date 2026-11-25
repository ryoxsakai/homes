// Homes 本棚: picture books the family borrows, owns or wants, with location, category and tags.
// The shelf is one revisioned document saved through the same-origin /api/books.
import { watchAuth, signOutUser } from '../shared/auth.js?v=14';
import { normalizeIsbn } from './isbn.mjs';
import { readBooksPreferences, writeBooksPreferences } from './preferences.mjs?v=borrowed-1';
import { prepareCoverPhoto } from './cover-photo.mjs';
import { cameraAvailable, startScanner } from './scanner.mjs?v=1';

const $ = selector => document.querySelector(selector);
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const STATUS_LABEL = { borrowed: '借りた', owned: '持っている', wanted: '欲しい' };

let shelf = { books: [], categories: [], locations: [] };
let revision = 0;
let saveQueue = Promise.resolve();
let pending = 0;
let broken = false;
const ui = readBooksPreferences(localStorageSafe());
const displayOptions = $('#books-display-options');
displayOptions.open = ui.filtersOpen;
$('#search').value = ui.query;

function localStorageSafe() { try { return window.localStorage; } catch { return null; } }
const rememberPrefs = () => writeBooksPreferences(localStorageSafe(), ui);

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const coverURL = book => book.photoId ? `/api/books/photo?id=${encodeURIComponent(book.photoId)}`
  : book.hasCover && book.volumeId ? `/api/books/cover?id=${encodeURIComponent(book.volumeId)}` : '';

function toast(message) {
  const box = $('#toast');
  // A modal dialog sits in the top layer, so the toast must live inside it to be seen.
  const host = document.querySelector('dialog[open]') || document.body;
  if (box.parentElement !== host) host.append(box);
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 2600);
}

// ─── Server ──────────────────────────────────────────────────────────
async function api(path, init) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...init });
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) throw Object.assign(Error(body?.error || `通信に失敗しました (${response.status})`), { status: response.status, ndlStatus: body?.ndlStatus });
  return body;
}

async function load() {
  const data = await api('/api/books');
  ({ revision } = data);
  shelf = { books: data.books, categories: data.categories, locations: data.locations };
}

// Saves the whole shelf after each change, one request at a time.
function save(message, coverChange) {
  const snapshot = structuredClone(shelf);
  pending++;
  $('#save-status').textContent = '保存中…';
  saveQueue = saveQueue.then(async () => {
    if (broken) return;
    try {
      const saved = await api('/api/books', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...snapshot, revision, ...(coverChange ? { coverChange } : {}) }),
      });
      revision = saved.revision;
      // Keep server-decided fields (who registered) without disturbing newer local edits.
      const byId = new Map(saved.books.map(b => [b.id, b]));
      for (const book of shelf.books) {
        if (!byId.has(book.id)) continue;
        const persisted = byId.get(book.id);
        book.createdBy = persisted.createdBy;
        if (persisted.photoId) book.photoId = persisted.photoId;
        else delete book.photoId;
      }
      if (message) toast(message);
    } catch (error) {
      broken = true;
      $('#save-status').innerHTML = `${esc(error.message)}。<button type="button" class="books-link-btn" id="reload">再読み込み</button>`;
      $('#reload').addEventListener('click', () => location.reload());
    }
  }).finally(() => {
    pending--;
    if (!pending && !broken) $('#save-status').textContent = '';
    render();
  });
  render();
}
window.addEventListener('beforeunload', event => {
  if (pending || broken || $('#book-dialog').open) { event.preventDefault(); event.returnValue = ''; }
});

// ─── List ────────────────────────────────────────────────────────────
const firstAuthor = b => b.authors[0] || '';
const sorters = {
  'added-desc': (a, b) => b.createdAt.localeCompare(a.createdAt),
  'added-asc': (a, b) => a.createdAt.localeCompare(b.createdAt),
  title: (a, b) => collator.compare(a.title, b.title),
  author: (a, b) => emptyLast(firstAuthor(a), firstAuthor(b)) || collator.compare(a.title, b.title),
  'published-desc': (a, b) => emptyLast(a.publishedDate, b.publishedDate, true) || collator.compare(a.title, b.title),
  'published-asc': (a, b) => emptyLast(a.publishedDate, b.publishedDate) || collator.compare(a.title, b.title),
  location: (a, b) => byOrder(shelf.locations, a.location, b.location) || collator.compare(a.title, b.title),
  category: (a, b) => byOrder(shelf.categories, a.category, b.category) || collator.compare(a.title, b.title),
};
function emptyLast(x, y, descending = false) {
  if (!x || !y) return (!x) - (!y);
  return descending ? collator.compare(y, x) : collator.compare(x, y);
}
// Follows the order set in 「カテゴリと場所」; unset values go last.
function byOrder(order, x, y) {
  const rank = v => v ? order.indexOf(v) : Infinity;
  return rank(x) - rank(y);
}

function visibleBooks() {
  const words = ui.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return shelf.books.filter(b =>
    (ui.status === 'all' || b.status === ui.status) &&
    (!ui.category || (ui.category === '-' ? !b.category : b.category === ui.category)) &&
    (!ui.location || (ui.location === '-' ? !b.location : b.location === ui.location)) &&
    (!ui.tag || b.tags.includes(ui.tag)) &&
    words.every(w => [b.title, ...b.authors, b.publisher, b.memo, ...b.tags, b.isbn].join('\n').toLowerCase().includes(w)),
  ).sort(sorters[ui.sort]);
}

const allTags = () => [...new Set(shelf.books.flatMap(b => b.tags))].sort(collator.compare);

// The visible labels are hidden: the unfiltered choice shows the filter's name
// ("カテゴリ") and a chosen value is highlighted, which keeps the text short on phones.
function fillSelect(select, items, current, { name, none }) {
  select.innerHTML = `<option value="">${esc(name)}</option>` +
    items.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('') +
    (none ? `<option value="-">${esc(name)}未設定</option>` : '');
  select.value = [...select.options].some(o => o.value === current) ? current : '';
  return select.value;
}

function coverMarkup(book, size = '', preview = '') {
  const url = preview || coverURL(book);
  const image = url ? `<img class="books-cover-img" src="${esc(url)}" alt="" loading="${size ? 'eager' : 'lazy'}" decoding="async">` : '';
  return image + `<span class="books-cover-blank ${size}" aria-hidden="true">${esc(book.title.slice(0, 24))}</span>`;
}
document.addEventListener('error', event => {
  if (event.target instanceof HTMLImageElement && event.target.classList.contains('books-cover-img'))
    event.target.hidden = true;
}, true);

function render() {
  const totals = { borrowed: 0, owned: 0, wanted: 0 };
  for (const { status } of shelf.books) if (Object.hasOwn(totals, status)) totals[status]++;
  $('#summary').textContent = Object.entries(STATUS_LABEL).map(([status, label]) => `${label} ${totals[status]}冊`).join('・');
  ui.category = fillSelect($('#filter-category'), shelf.categories, ui.category, { name: 'カテゴリ', none: true });
  ui.location = fillSelect($('#filter-location'), shelf.locations, ui.location, { name: '場所', none: true });
  ui.tag = fillSelect($('#filter-tag'), allTags(), ui.tag, { name: 'タグ' });
  $('#sort').value = ui.sort;
  const count = [ui.query.trim(), ui.category, ui.location, ui.tag].filter(Boolean).length;
  $('#books-active-filters').textContent = count ? `${count}件` : '';
  $('#books-active-filters').hidden = count === 0;
  $('#books-menu-filter-dot').hidden = count === 0;
  $('#books-reset-filters').hidden = count === 0 && ui.status === 'all';
  for (const b of document.querySelectorAll('[data-status]')) b.setAttribute('aria-pressed', String(b.dataset.status === ui.status));
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === ui.view));

  const books = visibleBooks();
  const list = $('#book-list');
  list.className = ui.view === 'list' ? 'books-list' : 'books-grid';
  list.innerHTML = books.map(b => {
    const badge = b.status === 'borrowed' || b.status === 'wanted'
      ? `<span class="books-status-badge books-status-${b.status}">${STATUS_LABEL[b.status]}</span>` : '';
    return `
    <li><button type="button" class="books-card" data-book="${esc(b.id)}">
      <span class="books-cover">${coverMarkup(b)}${ui.view === 'list' ? '' : badge}</span>
      <span class="books-card-text">
        <span class="books-card-heading"><span class="books-card-title">${esc(b.title)}</span>${ui.view === 'list' ? badge : ''}</span>
        ${b.authors.length ? `<span class="books-card-author">${esc(b.authors.join('、'))}</span>` : ''}
        <span class="books-card-tags">
          ${b.location ? `<span class="books-chip books-chip-place">${esc(b.location)}</span>` : ''}
          ${b.category ? `<span class="books-chip">${esc(b.category)}</span>` : ''}
          ${b.tags.map(t => `<span class="books-chip books-chip-tag">#${esc(t)}</span>`).join('')}
        </span>
      </span>
    </button></li>`;
  }).join('');
  const filtered = books.length !== shelf.books.length;
  $('#result-count').textContent = filtered ? `${books.length}冊を表示（全${shelf.books.length}冊）` : '';
  $('#empty').hidden = books.length > 0;
  $('#empty-text').textContent = shelf.books.length ? '条件に合う本がありません' : 'まだ本が登録されていません。バーコードを読み取って登録しましょう。';
  $('#empty-add').hidden = shelf.books.length > 0;
}

// ─── Dialogs ─────────────────────────────────────────────────────────
let returnFocus = null;
function openDialog(dialog) {
  returnFocus = document.activeElement;
  dialog.showModal();
}
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-close]')) requestClose(dialog);
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(dialog); });
  dialog.addEventListener('close', () => {
    if (dialog === $('#add-dialog')) stopScan();
    returnFocus?.focus?.({ preventScroll: true });
  });
}
function requestClose(dialog) {
  if (dialog === $('#book-dialog') && editor.dirty() && !confirm('入力した内容を破棄しますか？')) return;
  dialog.close();
}

// ─── Register: scan or type an ISBN ─────────────────────────────────
let stopCamera = null;
// Each opening of the registration dialog is a session. A lookup answers only the
// session that asked, and only while that dialog is still open, so a slow reply
// can never replace a book the family has meanwhile started editing.
let addSession = 0;
let lookingIn = null;

function openAdd() {
  addSession++;
  $('#isbn-input').value = '';
  setScanMessage('裏表紙の上段のバーコード（978から始まる番号）を枠に合わせてください。');
  $('#scan-start').hidden = !cameraAvailable();
  openDialog($('#add-dialog'));
  if (cameraAvailable()) beginScan();
  else { setScanMessage('この端末ではカメラを使えません。ISBNを入力してください。'); $('#isbn-input').focus(); }
}
window.homesBooksQuickAdd = openAdd;

function setScanMessage(text, tone = '') {
  const box = $('#scan-message');
  box.textContent = text;
  box.dataset.tone = tone;
}

// Each start gets a number, so a camera that finishes starting after the family
// pressed stop, typed an ISBN or closed the dialog is shut down straight away.
let scanSession = 0;
async function beginScan() {
  if (stopCamera) return;
  const session = ++scanSession;
  showScanner(true);
  setScanMessage('カメラを起動しています…');
  try {
    const stop = await startScanner($('#scanner-video'), {
      onIsbn: isbn => { stopCamera = null; showScanner(false); lookup(isbn); },
      onOther: () => setScanMessage('上段の「978」から始まるバーコードを写してください（下段は価格のバーコードです）。', 'warn'),
    });
    if (session !== scanSession || !$('#add-dialog').open) { stop(); return; }
    stopCamera = stop;
    setScanMessage('裏表紙の上段のバーコード（978から始まる番号）を枠に合わせてください。');
  } catch (error) {
    if (session !== scanSession) return;
    showScanner(false);
    setScanMessage(error.message, 'error');
  }
}
function showScanner(on) {
  $('#scanner').hidden = !on;
  $('#scan-stop').hidden = !on;
  $('#scan-start').hidden = on || !cameraAvailable();
}
function stopScan() {
  scanSession++;
  stopCamera?.();
  stopCamera = null;
  showScanner(false);
}

async function lookup(raw) {
  const isbn = normalizeIsbn(raw);
  if (!isbn) { setScanMessage('ISBNの番号を確認してください（13桁または10桁）。', 'error'); return; }
  const existing = shelf.books.find(b => b.isbn === isbn);
  if (existing) {
    $('#add-dialog').close();
    editor.open(existing);
    toast('この本はすでに登録されています');
    return;
  }
  const session = addSession;
  if (lookingIn === session) return;
  lookingIn = session;
  const current = () => session === addSession && $('#add-dialog').open;
  setScanMessage(`ISBN ${isbn} を検索しています…`);
  try {
    const found = await api(`/api/books/lookup?isbn=${isbn}`);
    if (!current()) return;
    $('#add-dialog').close();
    if (found.found) {
      editor.open(null, found);
      if (found.source === 'ndl') toast('国立国会図書館サーチから書誌情報を入力しました');
    }
    else {
      editor.open(null, { isbn });
      toast('書誌情報が見つからなかったため、手入力してください');
    }
  } catch (error) {
    if (!current()) return;
    const ndl = error.ndlStatus;
    const ndlReason = /^http-\d{3}$/.test(ndl || '') ? `HTTP ${ndl.slice(5)}`
      : ({ timeout: '応答なし', 'request-failed': '通信エラー', 'no-exact-match': '該当なし' })[ndl] || '';
    const message = error.message.replace(/。$/, '') + '。' +
      (ndlReason ? `国立国会図書館サーチも取得できませんでした（${ndlReason}）。` : '');
    setScanMessage(message, 'error');
    if (error.status === 503) {
      // The family can still register the book by hand.
      const manual = document.createElement('button');
      manual.type = 'button';
      manual.className = 'books-link-btn';
      manual.textContent = 'このISBNで手入力する';
      manual.addEventListener('click', () => { $('#add-dialog').close(); editor.open(null, { isbn }); });
      $('#scan-message').append(' ', manual);
    }
  } finally {
    if (lookingIn === session) lookingIn = null;
  }
}

// ─── Edit dialog ─────────────────────────────────────────────────────
const NEW_OPTION = '__new__';
const editor = (() => {
  const dialog = $('#book-dialog');
  const form = $('#book-form');
  let current = null;   // Book being edited, or null when adding.
  let draft = null;     // Looked-up or blank values for a new book.
  let tags = [];
  let initial = '';
  let photo = undefined; // unchanged; null means remove, object means replace.
  let photoGeneration = 0;
  let preparingPhoto = false;

  const values = () => ({
    status: form.status.value, title: form.title.value, authors: form.authors.value,
    publisher: form.publisher.value, publishedDate: form.publishedDate.value,
    location: form.location.value, category: form.category.value, memo: form.memo.value, tags: [...tags],
  });

  function options(select, items, value, label) {
    select.innerHTML = `<option value="">未設定</option>` +
      items.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('') +
      `<option value="${NEW_OPTION}">＋ 新しい${label}…</option>`;
    select.value = items.includes(value) ? value : '';
    select.dataset.previous = select.value;
  }

  function renderTags() {
    $('#tag-chips').innerHTML = tags.map((t, i) =>
      `<li class="books-chip books-chip-tag">#${esc(t)}<button type="button" data-remove-tag="${i}" aria-label="タグ「${esc(t)}」を外す">×</button></li>`).join('');
    $('#tag-options').innerHTML = allTags().filter(t => !tags.includes(t)).map(t => `<option value="${esc(t)}">`).join('');
  }
  function addTag(raw) {
    const tag = raw.trim().replace(/^#/, '').slice(0, 50);
    if (!tag) return;
    if (tags.length >= 30) { toast('タグは30個までです'); return; }
    if (!tags.includes(tag)) tags.push(tag);
    renderTags();
  }

  const coverSearch = $('#cover-image-search');
  function updateCoverSearch() {
    const title = form.title.value.trim();
    if (title) {
      const url = new URL('https://www.google.com/search');
      url.searchParams.set('tbm', 'isch');
      url.searchParams.set('q', title + ' 表紙');
      coverSearch.href = url.href;
    } else {
      coverSearch.removeAttribute('href');
    }
    coverSearch.hidden = !title;
  }
  form.title.addEventListener('input', updateCoverSearch);

  function open(book, found = {}) {
    current = book;
    draft = book ? null : {
      isbn: found.isbn || '', volumeId: found.volumeId || '', hasCover: !!found.hasCover,
      title: found.title || '', authors: found.authors || [], publisher: found.publisher || '', publishedDate: found.publishedDate || '',
    };
    const src = book || draft;
    $('#book-title').textContent = book ? '本の情報' : '本を登録';
    $('#save-book').textContent = book ? '保存' : '本棚に登録';
    $('#delete-book').hidden = !book;
    form.status.value = book?.status || 'owned';
    form.title.value = src.title;
    updateCoverSearch();
    form.authors.value = src.authors.join('、');
    form.publisher.value = src.publisher;
    form.publishedDate.value = src.publishedDate;
    options(form.location, shelf.locations, book?.location ?? '', '場所');
    options(form.category, shelf.categories, book?.category ?? (shelf.categories.includes('絵本') ? '絵本' : ''), 'カテゴリ');
    form.memo.value = book?.memo || '';
    tags = [...(book?.tags || [])];
    $('#tag-entry').value = '';
    renderTags();
    photoGeneration++;
    photo = undefined;
    preparingPhoto = false;
    $('#save-book').disabled = false;
    $('#cover-status').textContent = '';
    renderCover();
    $('#book-meta').textContent = book
      ? [`登録 ${new Date(book.createdAt).toLocaleDateString('ja-JP')}`, book.createdBy && `${book.createdBy}が登録`].filter(Boolean).join('・')
      : '';
    initial = JSON.stringify(values());
    if (!dialog.open) openDialog(dialog);
    (book ? form.querySelector('[name=status]:checked') : form.title.value ? form.location : form.title).focus();
  }

  function renderCover() {
    const src = current || draft;
    const visible = photo === undefined ? src : { ...src, photoId: undefined };
    $('#edit-cover').innerHTML = `<span class="books-cover books-cover-large">${coverMarkup(visible, 'large', photo?.dataURL)}</span>` +
      (src.isbn ? `<span class="books-isbn">ISBN ${esc(src.isbn)}</span>` : '<span class="books-isbn">ISBNなし</span>');
    $('#remove-cover').hidden = !(photo || (photo === undefined && src.photoId));
  }

  for (const button of dialog.querySelectorAll('[data-cover-input]'))
    button.addEventListener('click', () => document.getElementById(button.dataset.coverInput).click());

  for (const input of [$('#pick-cover'), $('#capture-cover')]) {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      const generation = ++photoGeneration;
      preparingPhoto = true;
      $('#save-book').disabled = true;
      $('#cover-status').textContent = '写真を準備しています…';
      try {
        const prepared = await prepareCoverPhoto(file);
        if (generation !== photoGeneration || !dialog.open) return;
        photo = prepared;
        renderCover();
        $('#cover-status').textContent = '本を保存すると写真も保存されます。';
      } catch (error) {
        if (generation === photoGeneration && dialog.open) $('#cover-status').textContent = error.message;
      } finally {
        if (generation === photoGeneration && dialog.open) {
          preparingPhoto = false;
          $('#save-book').disabled = false;
        }
      }
    });
  }
  $('#remove-cover').addEventListener('click', () => {
    photoGeneration++;
    preparingPhoto = false;
    $('#save-book').disabled = false;
    photo = current?.photoId ? null : undefined;
    renderCover();
    $('#cover-status').textContent = current?.photoId ? '本を保存すると写真を外します。' : '';
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    photoGeneration++;
    photo = undefined;
    preparingPhoto = false;
    $('#edit-cover').replaceChildren();
  });

  // "＋ 新しい場所…" adds an entry to the shelf's list on the spot.
  for (const [select, kind, label] of [[form.location, 'locations', '場所'], [form.category, 'categories', 'カテゴリ']]) {
    select.addEventListener('change', () => {
      if (select.value !== NEW_OPTION) { select.dataset.previous = select.value; return; }
      const name = (prompt(`新しい${label}の名前`) || '').trim().slice(0, 50);
      if (!name) { select.value = select.dataset.previous || ''; return; }
      if (!shelf[kind].includes(name)) { shelf[kind].push(name); save(); }
      options(select, shelf[kind], name, label);
    });
  }

  $('#tag-entry').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addTag(event.target.value); event.target.value = ''; }
    if (event.key === 'Backspace' && !event.target.value && tags.length) { tags.pop(); renderTags(); }
  });
  $('#tag-entry').addEventListener('change', event => {
    // Picking a suggestion from the datalist.
    if (allTags().includes(event.target.value)) { addTag(event.target.value); event.target.value = ''; }
  });
  $('#tag-chips').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-tag]');
    if (!button) return;
    tags.splice(Number(button.dataset.removeTag), 1);
    renderTags();
    $('#tag-entry').focus();
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (preparingPhoto) return;
    if ($('#tag-entry').value.trim()) { addTag($('#tag-entry').value); $('#tag-entry').value = ''; }
    const v = values();
    const title = v.title.trim();
    if (!title) { toast('タイトルを入力してください'); form.title.focus(); return; }
    const now = new Date().toISOString();
    const fields = {
      status: v.status, title: title.slice(0, 300),
      authors: v.authors.split(/[、,，\n]/).map(a => a.trim().slice(0, 200)).filter(Boolean).slice(0, 20),
      publisher: v.publisher.trim().slice(0, 200), publishedDate: v.publishedDate.trim().slice(0, 20),
      location: v.location === NEW_OPTION ? '' : v.location, category: v.category === NEW_OPTION ? '' : v.category,
      tags: v.tags, memo: v.memo.slice(0, 5000), updatedAt: now,
    };
    const id = current?.id || crypto.randomUUID();
    const photoChange = photo === undefined ? undefined : { id, jpeg: photo?.jpeg ?? null };
    if (current) {
      Object.assign(current, fields);
      save('保存しました', photoChange);
    } else {
      shelf.books.push({ id, ...draft, ...fields, createdAt: now, createdBy: null });
      save(fields.status === 'wanted' ? '欲しい本に追加しました' : fields.status === 'borrowed' ? '借りた本に追加しました' : '本棚に登録しました', photoChange);
    }
    initial = JSON.stringify(values());
    dialog.close();
  });

  $('#delete-book').addEventListener('click', () => {
    if (!current || !confirm(`「${current.title}」を本棚から削除しますか？`)) return;
    shelf.books = shelf.books.filter(b => b !== current);
    initial = JSON.stringify(values());
    dialog.close();
    save('削除しました');
  });

  return { open, dirty: () => dialog.open && (preparingPhoto || photo !== undefined || JSON.stringify(values()) !== initial) };
})();

// ─── Categories and locations ────────────────────────────────────────
function renderManage() {
  for (const section of document.querySelectorAll('.books-manage')) {
    const kind = section.dataset.kind;
    section.querySelector('ul').innerHTML = shelf[kind].map((name, i) => {
      const count = shelf.books.filter(b => b[kind === 'categories' ? 'category' : 'location'] === name).length;
      return `<li>
        <span class="books-manage-name">${esc(name)}<small>${count}冊</small></span>
        <button type="button" class="books-icon-btn" data-move="${i}" data-dir="-1" aria-label="${esc(name)}を上へ" ${i ? '' : 'disabled'}>↑</button>
        <button type="button" class="books-icon-btn" data-rename="${i}" aria-label="${esc(name)}の名前を変更">✎</button>
        <button type="button" class="books-icon-btn" data-remove="${i}" aria-label="${esc(name)}を削除">🗑</button>
      </li>`;
    }).join('') || '<li class="books-manage-empty">まだありません</li>';
  }
}
for (const section of document.querySelectorAll('.books-manage')) {
  const kind = section.dataset.kind;
  const field = kind === 'categories' ? 'category' : 'location';
  const label = kind === 'categories' ? 'カテゴリ' : '場所';
  section.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    const input = event.target.querySelector('input');
    const name = input.value.trim().slice(0, 50);
    if (!name) return;
    if (shelf[kind].includes(name)) { toast(`同じ${label}があります`); return; }
    if (shelf[kind].length >= 200) { toast(`${label}は200件までです`); return; }
    shelf[kind].push(name);
    input.value = '';
    renderManage();
    save();
  });
  section.querySelector('ul').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const list = shelf[kind];
    if (button.dataset.move) {
      const i = Number(button.dataset.move);
      [list[i - 1], list[i]] = [list[i], list[i - 1]];
    } else if (button.dataset.rename) {
      const i = Number(button.dataset.rename), old = list[i];
      const name = (prompt(`${label}の新しい名前`, old) || '').trim().slice(0, 50);
      if (!name || name === old) return;
      if (list.includes(name)) { toast(`同じ${label}があります`); return; }
      list[i] = name;
      for (const b of shelf.books) if (b[field] === old) b[field] = name;
      if (ui[field] === old) ui[field] = name;
    } else if (button.dataset.remove) {
      const i = Number(button.dataset.remove), old = list[i];
      const count = shelf.books.filter(b => b[field] === old).length;
      if (!confirm(count ? `「${old}」を削除しますか？ ${count}冊の${label}は未設定になります。` : `「${old}」を削除しますか？`)) return;
      list.splice(i, 1);
      for (const b of shelf.books) if (b[field] === old) b[field] = '';
    }
    renderManage();
    save();
  });
}

// ─── Wiring ──────────────────────────────────────────────────────────
$('#open-add').addEventListener('click', openAdd);
$('#empty-add').addEventListener('click', openAdd);
$('#open-manage').addEventListener('click', () => { renderManage(); openDialog($('#manage-dialog')); });
$('#scan-start').addEventListener('click', beginScan);
$('#scan-stop').addEventListener('click', () => { stopScan(); setScanMessage('ISBNを入力して検索することもできます。'); });
$('#isbn-form').addEventListener('submit', event => { event.preventDefault(); stopScan(); lookup($('#isbn-input').value); });
$('#manual-entry').addEventListener('click', () => { $('#add-dialog').close(); editor.open(null, {}); });
$('#book-list').addEventListener('click', event => {
  const card = event.target.closest('[data-book]');
  const book = card && shelf.books.find(b => b.id === card.dataset.book);
  if (book) editor.open(book);
});
// A cover that fails to load falls back to the title block.
$('#book-list').addEventListener('error', event => {
  if (event.target.matches?.('img.books-cover-img')) {
    const span = document.createElement('span');
    span.className = 'books-cover-blank';
    span.textContent = event.target.closest('.books-card')?.querySelector('.books-card-title')?.textContent.slice(0, 24) || '';
    event.target.replaceWith(span);
  }
}, true);
const updateView = (patch) => {
  Object.assign(ui, patch);
  render();
  rememberPrefs();
};
for (const button of document.querySelectorAll('[data-status]')) button.addEventListener('click', () => updateView({ status: button.dataset.status }));
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => updateView({ view: button.dataset.view }));
for (const [selector, prop, eventType] of [
  ['#search', 'query', 'input'], ['#filter-category', 'category', 'change'],
  ['#filter-location', 'location', 'change'], ['#filter-tag', 'tag', 'change'],
  ['#sort', 'sort', 'change'],
]) $(selector).addEventListener(eventType, event => updateView({ [prop]: event.target.value }));
const syncOptions = () => {
  ui.filtersOpen = displayOptions.open;
  $('#books-menu-filter').setAttribute('aria-expanded', String(ui.filtersOpen));
  if (ui.filtersOpen) $('#books-menu-list').removeAttribute('aria-current');
  else $('#books-menu-list').setAttribute('aria-current', 'page');
};
syncOptions();
displayOptions.addEventListener('toggle', () => { syncOptions(); rememberPrefs(); });
$('#books-menu-list').addEventListener('click', () => {
  displayOptions.open = false;
  $('#books-main').scrollIntoView({ block: 'start' });
});
$('#books-menu-filter').addEventListener('click', () => {
  displayOptions.open = !displayOptions.open;
  if (displayOptions.open) displayOptions.scrollIntoView({ block: 'nearest' });
});
$('#books-menu-add').addEventListener('click', openAdd);
$('#books-reset-filters').addEventListener('click', () => {
  $('#search').value = '';
  updateView({ status: 'all', query: '', category: '', location: '', tag: '' });
  displayOptions.querySelector('summary').focus();
});
$('#sign-out').addEventListener('click', async () => {
  if (!confirm('ログアウトしますか？')) return;
  await signOutUser();
  if (window === top) location.replace('/');
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan(); });

watchAuth({
  async onSignedIn() {
    try {
      await load();
      $('#loading').hidden = true;
      $('#books-main').hidden = false;
      $('#user-bar').hidden = false;
      render();
      rememberPrefs();
    } catch (error) {
      $('#loading').textContent = `本棚を読み込めませんでした（${error.message}）。再読み込みしてください。`;
    }
    document.body.dataset.serviceReady = 'true';
  },
  onSignedOut(message) {
    if (message) $('#loading').textContent = message;
    document.body.dataset.serviceReady = 'true';
  },
});
