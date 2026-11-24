// Bookshelf (本棚) for Homes: the household's picture books, owned or wanted.
// The whole shelf is one revisioned document, like the Works-based ToDo and Memo.
// Book metadata and covers come from Google Books through this Worker, so pages
// keep their same-origin CSP and family browsers never contact Google directly.
import { failure } from './state.mjs';
import { isIsbn13, normalizeIsbn } from '../public/books/isbn.mjs';

export { isIsbn13, normalizeIsbn };

export const BOOK_STATUSES = ['owned', 'wanted'];
export const MAX_BOOKS = 3000;
const VOLUME_ID = /^[A-Za-z0-9_-]{4,40}$/;
const reject = message => { throw failure(400, message); };
const str = (v, max) => typeof v === 'string' && v.length <= max;
const filled = (v, max) => str(v, max) && v.trim().length > 0;
const isoTime = v => str(v, 40) && !Number.isNaN(Date.parse(v));
const names = (list, max, size) => Array.isArray(list) && list.length <= max &&
  list.every(v => filled(v, size)) && new Set(list).size === list.length;

export const emptyBooks = () => ({
  books: [],
  categories: ['絵本', '図鑑', '児童書'],
  locations: ['リビングの本棚', '子ども部屋'],
});

export function validateBooks(state) {
  if (!state || !Array.isArray(state.books) || state.books.length > MAX_BOOKS ||
      !names(state.categories, 200, 50) || !names(state.locations, 200, 50) ||
      new Set(state.books.map(b => b?.id)).size !== state.books.length)
    reject('本棚の入力形式が不正です');
  for (const b of state.books) {
    if (!b || !filled(b.id, 120) || !(b.isbn === '' || isIsbn13(b.isbn)) || !filled(b.title, 300) ||
        !Array.isArray(b.authors) || b.authors.length > 20 || !b.authors.every(a => filled(a, 200)) ||
        !str(b.publisher, 200) || !str(b.publishedDate, 20) ||
        !(b.volumeId === '' || VOLUME_ID.test(b.volumeId)) || typeof b.hasCover !== 'boolean' ||
        !BOOK_STATUSES.includes(b.status) ||
        !(b.location === '' || state.locations.includes(b.location)) ||
        !(b.category === '' || state.categories.includes(b.category)) ||
        !names(b.tags, 30, 50) || !str(b.memo, 5000) ||
        !isoTime(b.createdAt) || !isoTime(b.updatedAt) ||
        !(b.createdBy === null || filled(b.createdBy, 40)))
      reject('本の入力内容を確認してください');
  }
  return state;
}

// Returns the next stored document, or throws {status} errors. Who registered a
// book is decided here from the signed-in member, never by the browser.
export function nextBooks(current, input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('本棚の入力形式が不正です');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) reject('revision is required');
  if (input.revision !== current.revision) throw failure(409, '別の画面で変更されています。再読み込みしてください');
  const state = structuredClone({ books: input.books, categories: input.categories, locations: input.locations });
  if (!Array.isArray(state.books)) reject('本棚の入力形式が不正です');
  const previous = new Map(current.books.map(b => [b.id, b]));
  for (const book of state.books) {
    if (book && typeof book === 'object') book.createdBy = previous.has(book.id) ? previous.get(book.id).createdBy ?? null : actor;
  }
  validateBooks(state);
  return state;
}

const lookupURL = (isbn, key) => {
  const url = new URL('https://www.googleapis.com/books/v1/volumes');
  url.search = new URLSearchParams({
    q: 'isbn:' + isbn, maxResults: '5', printType: 'books',
    // Without a country, server-side calls can be refused as "location unknown".
    country: 'JP',
    fields: 'items(id,volumeInfo(title,subtitle,authors,publisher,publishedDate,imageLinks/thumbnail,industryIdentifiers))',
    ...(key && { key }),
  });
  return url;
};

const clip = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

// GET /api/books/lookup?isbn=… → { found, isbn, title, authors, publisher, publishedDate, volumeId, hasCover }
export async function lookupBook(rawIsbn, env, upstream = fetch) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return { error: { status: 400, message: 'ISBNを確認してください' } };
  let response;
  try {
    response = await upstream(lookupURL(isbn, env.GOOGLE_BOOKS_API_KEY), {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
  } catch {
    return { error: { status: 503, message: 'Google Booksに接続できませんでした' } };
  }
  if (response.status === 429 || response.status === 403)
    return { error: { status: 503, message: 'Google Booksの利用上限に達しました。時間をおくか手入力してください' } };
  if (!response.ok) return { error: { status: 503, message: 'Google Booksで検索できませんでした' } };
  let data;
  try { data = await response.json(); } catch { return { error: { status: 503, message: 'Google Booksの応答を読めませんでした' } }; }
  const items = Array.isArray(data?.items) ? data.items : [];
  // Prefer the volume that really carries this ISBN; full-text matches can be other books.
  const item = items.find(i => i?.volumeInfo?.industryIdentifiers?.some?.(x => normalizeIsbn(String(x?.identifier ?? '')) === isbn)) || items[0];
  const info = item?.volumeInfo;
  if (!info || !clip(info.title, 300)) return { value: { found: false, isbn } };
  const title = [clip(info.title, 300), clip(info.subtitle, 200)].filter(Boolean).join(' ').slice(0, 300);
  return {
    value: {
      found: true, isbn, title,
      authors: Array.isArray(info.authors) ? info.authors.map(a => clip(a, 200)).filter(Boolean).slice(0, 20) : [],
      publisher: clip(info.publisher, 200),
      publishedDate: clip(info.publishedDate, 20),
      volumeId: VOLUME_ID.test(item.id) ? item.id : '',
      hasCover: VOLUME_ID.test(item.id) && typeof info.imageLinks?.thumbnail === 'string',
    },
  };
}

const MAX_COVER_BYTES = 1_000_000;
const IMAGE_TYPE = /^image\/(jpeg|png|gif|webp)$/;

// GET /api/books/cover?id=<volumeId> → the front cover thumbnail, cached at the edge.
// Only a fixed Google Books URL is ever fetched; the id is the sole variable part.
export async function fetchCover(volumeId, upstream = fetch) {
  if (!VOLUME_ID.test(volumeId || '')) return null;
  const url = new URL('https://books.google.com/books/content');
  url.search = new URLSearchParams({ id: volumeId, printsec: 'frontcover', img: '1', zoom: '1', source: 'gbs_api' });
  try {
    const response = await upstream(url, { cf: { cacheTtl: 2592000, cacheEverything: true } });
    const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const length = Number(response.headers.get('Content-Length'));
    if (!response.ok || !IMAGE_TYPE.test(type) || length > MAX_COVER_BYTES) return null;
    const body = await response.arrayBuffer();
    if (!body.byteLength || body.byteLength > MAX_COVER_BYTES) return null;
    return { body, type };
  } catch { return null; }
}
