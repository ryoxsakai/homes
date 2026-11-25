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
    if (book && typeof book === 'object') {
      const prev = previous.get(book.id);
      book.createdBy = prev ? prev.createdBy ?? null : actor;
      // Only the private photo storage transaction may change this reference.
      delete book.photoId;
      if (prev?.photoId) book.photoId = prev.photoId;
    }
  }
  validateBooks(state);
  return state;
}

const lookupURL = isbn => {
  const url = new URL('https://www.googleapis.com/books/v1/volumes');
  url.search = new URLSearchParams({
    q: 'isbn:' + isbn, maxResults: '5', printType: 'books',
    // Without a country, server-side calls can be refused as "location unknown".
    country: 'JP',
    fields: 'items(id,volumeInfo(title,subtitle,authors,publisher,publishedDate,imageLinks/thumbnail,industryIdentifiers))',
  });
  return url;
};

// Google's error body names the cause (ErrorInfo.reason or errors[].reason).
async function googleReason(response) {
  try {
    const { error } = await response.json();
    const info = error?.details?.find?.(d => d?.reason)?.reason || '';
    const legacy = error?.errors?.[0]?.reason || '';
    return { code: String(info || legacy || error?.status || ''), message: String(error?.message || '') };
  } catch {
    return { code: '', message: '' };
  }
}

// Family-facing explanation of why Google refused, with what to check.
export function explain(status, { code, message }, hasKey) {
  const text = `${code} ${message}`;
  if (/API_KEY_INVALID|keyInvalid|API key not valid/i.test(text))
    return 'Google BooksのAPIキーが無効です。Workerのシークレット GOOGLE_BOOKS_API_KEY の値を確認してください';
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(text))
    return 'APIキーのプロジェクトでBooks APIが有効になっていません。Google CloudでBooks APIを有効にしてください（反映まで数分かかります）';
  if (/API_KEY_.*_BLOCKED|blocked/i.test(text))
    return 'APIキーの制限で拒否されました。Google Cloudでキーの「アプリケーションの制限」を「なし」、「APIの制限」をBooks APIにしてください';
  if (/location/i.test(text)) return 'Google Booksが地域を判定できず拒否しました。時間をおいて試すか、手入力してください';
  if (status === 429 || /RATE_LIMIT|rateLimitExceeded|quota/i.test(text))
    return hasKey
      ? 'Google Booksの利用上限に達しました。時間をおくか手入力してください'
      : 'Google Booksの利用上限に達しました。WorkerにAPIキー（GOOGLE_BOOKS_API_KEY）が設定されていません';
  return `Google Booksで検索できませんでした（${status}${code ? ` ${code}` : ''}）`;
}

const clip = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

// GET /api/books/lookup?isbn=… → { found, isbn, title, authors, publisher, publishedDate, volumeId, hasCover }
export async function lookupBook(rawIsbn, env, upstream = fetch) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return { error: { status: 400, message: 'ISBNを確認してください' } };
  const google = await lookupGoogleBook(isbn, env, upstream);
  if (google.value?.found) return google;
  const ndl = await lookupNdlBook(isbn, upstream);
  if (ndl.value) return ndl;
  return google.error ? { ...google, ndlStatus: ndl.status } : google;
}

async function lookupGoogleBook(isbn, env, upstream) {
  const key = typeof env.GOOGLE_BOOKS_API_KEY === 'string' ? env.GOOGLE_BOOKS_API_KEY.trim() : '';
  let response;
  try {
    response = await upstream(lookupURL(isbn), {
      // The key travels in a header, so it is not part of the URL, the edge cache key or logs.
      headers: { Accept: 'application/json', ...(key && { 'X-Goog-Api-Key': key }) },
      signal: AbortSignal.timeout(5000),
      // Cache successful answers only; a refusal must not stick after the key is fixed.
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 86400, '300-599': 0 } },
    });
  } catch {
    return { error: { status: 503, message: 'Google Booksに接続できませんでした' } };
  }
  if (!response.ok) {
    const reason = await googleReason(response);
    console.error('Google Books lookup failed', response.status, reason.code, key ? 'with key' : 'without key');
    return { error: { status: 503, message: explain(response.status, reason, !!key) } };
  }
  let data;
  try { data = await response.json(); } catch { return { error: { status: 503, message: 'Google Booksの応答を読めませんでした' } }; }
  const items = Array.isArray(data?.items) ? data.items : [];
  // Prefer the volume that really carries this ISBN; full-text matches can be other books.
  const item = items.find(i => i?.volumeInfo?.industryIdentifiers?.some?.(x => normalizeIsbn(String(x?.identifier ?? '')) === isbn));
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

// NDL Search SRU, using only NDL's own catalogue. Accept an
// exact ISBN (older records can contain the ISBN-10 spelling in both fields).
const NDL_RECORD = /^https:\/\/ndlsearch\.ndl\.go\.jp\/books\/R100000002-I[0-9]+#material$/;
const NDL_MAX_BYTES = 256_000;
const xmlEntities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = raw => raw.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, value) => {
  if (value in xmlEntities) return xmlEntities[value];
  if (value[0] !== '#') return entity;
  const n = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : entity;
});

async function readNdlXml(response) {
  if (!response.body || !/xml/i.test(response.headers.get('content-type') ?? '')) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, rss = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return rss + decoder.decode();
      size += value.byteLength;
      if (size > NDL_MAX_BYTES) { await reader.cancel(); return ''; }
      rss += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

async function lookupNdlBook(isbn, upstream) {
  const url = new URL('https://ndlsearch.ndl.go.jp/api/sru');
  url.search = new URLSearchParams({
    operation: 'searchRetrieve', version: '1.2', maximumRecords: '3',
    recordSchema: 'dcndl', recordPacking: 'xml', onlyBib: 'true',
    query: 'dpid="iss-ndl-opac" AND isbn="' + isbn + '"',
  });
  try {
    const response = await upstream(url, {
      headers: { Accept: 'application/xml, text/xml' },
      redirect: 'manual', signal: AbortSignal.timeout(18000),
    });
    if (!response.ok) return { status: 'http-' + response.status };
    const xml = await readNdlXml(response);
    if (!/<searchRetrieveResponse[\s>]/.test(xml) || /<!DOCTYPE|<!ENTITY|<diagnostics[\s>]/i.test(xml)) return { status: 'invalid-response' };
    for (const [, attributes, record] of xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
      .matchAll(/<dcndl:BibResource\b([^>]*)>([\s\S]*?)<\/dcndl:BibResource>/g)) {
      const link = xmlText(attributes.match(/\brdf:about="([^"]+)"/)?.[1] ?? '');
      if (!NDL_RECORD.test(link)) continue;
      const ids = [...record.matchAll(/<dcterms:identifier\b([^>]*)>([^<]*)<\/dcterms:identifier>/g)];
      if (!ids.some(([, attrs, id]) => /\brdf:datatype="http:\/\/ndl\.go\.jp\/dcndl\/terms\/ISBN(?:13)?"/.test(attrs) &&
          normalizeIsbn(xmlText(id)) === isbn)) continue;
      const read = (tag, size, origin = record) => clip(xmlText(origin.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([^<]*)</' + tag + '>'))?.[1] ?? ''), size);
      const title = read('dcterms:title', 300) || read('dc:title', 300);
      if (!title) continue;
      const authors = [...record.matchAll(/<dc:creator(?:\s[^>]*)?>([^<]*)<\/dc:creator>/g)]
        .map(([, s]) => clip(xmlText(s).replace(/\s+(?:さく・え|作・絵|著|絵|作)$/, ''), 200)).filter(Boolean).slice(0, 20);
      const publishers = record.match(/<dcterms:publisher\b[^>]*>([\s\S]*?)<\/dcterms:publisher>/)?.[1] ?? '';
      const date = read('dcterms:issued', 20) || read('dcterms:date', 20);
      return { value: { found: true, isbn, title, authors,
        publisher: read('foaf:name', 200, publishers) || read('dc:publisher', 200),
        publishedDate: date.replace(/\./g, '-'), volumeId: '', hasCover: false, source: 'ndl' } };
    }
    return { status: 'no-exact-match' };
  } catch (error) {
    return { status: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'request-failed' };
  }
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
