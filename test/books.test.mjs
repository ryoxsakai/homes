import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyBooks, explain, fetchCover, isIsbn13, lookupBook, nextBooks, normalizeIsbn, validateBooks } from '../worker/books.mjs';
import { createApp } from '../worker/auth.mjs';

const book = (over = {}) => ({
  id: 'b1', isbn: '9784834000825', title: 'ぐりとぐら', authors: ['なかがわりえこ', 'おおむらゆりこ'],
  publisher: '福音館書店', publishedDate: '1967-01', volumeId: 'abcd1234', hasCover: true,
  status: 'owned', location: 'リビングの本棚', category: '絵本', tags: ['寝る前'], memo: '',
  createdAt: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T10:00:00.000Z', createdBy: null, ...over,
});
const shelf = (books = [book()]) => ({ ...emptyBooks(), books });

test('ISBN check digits, ISBN-10 conversion and the Japanese price barcode', () => {
  assert.equal(isIsbn13('9784834000825'), true);
  assert.equal(isIsbn13('9784834000826'), false);
  assert.equal(normalizeIsbn('4-8340-0082-6'), '9784834000825');
  assert.equal(normalizeIsbn('978-4-8340-0082-5'), '9784834000825');
  assert.equal(normalizeIsbn('4834000827'), null);
  // The lower "192…" barcode on Japanese books is a price code, not an ISBN.
  assert.equal(normalizeIsbn('1920193012004'), null);
});

test('shelf documents are validated against their own lists', () => {
  validateBooks(shelf());
  validateBooks(shelf([book({ isbn: '', volumeId: '', hasCover: false, location: '', category: '', status: 'wanted' })]));
  for (const bad of [
    { location: '物置' }, { category: '不明' }, { status: 'lent' }, { isbn: '9784834000826' },
    { title: ' ' }, { tags: ['a', 'a'] }, { volumeId: '../x' }, { createdAt: 'yesterday' }, { authors: 'x' },
  ]) assert.throws(() => validateBooks(shelf([book(bad)])), { status: 400 }, JSON.stringify(bad));
  assert.throws(() => validateBooks({ ...shelf(), categories: ['絵本', '絵本'] }), { status: 400 });
  assert.throws(() => validateBooks(shelf([book(), book()])), { status: 400 });
});

test('the server records who registered a book and enforces the revision', () => {
  const current = { ...shelf([]), revision: 2 };
  const added = nextBooks(current, { ...shelf([book({ createdBy: '偽名' })]), revision: 2 }, '家族A');
  assert.equal(added.books[0].createdBy, '家族A');
  const edited = nextBooks({ ...added, revision: 3 }, { ...shelf([book({ title: 'ぐりとぐらのえんそく', createdBy: '家族B' })]), revision: 3 }, '家族B');
  assert.equal(edited.books[0].createdBy, '家族A');
  assert.equal(edited.books[0].title, 'ぐりとぐらのえんそく');
  assert.throws(() => nextBooks({ ...added, revision: 3 }, { ...shelf(), revision: 2 }, '家族A'), { status: 409 });
  assert.throws(() => nextBooks(current, { ...shelf() }, '家族A'), { status: 400 });
});

test('Google Books lookup picks the volume with this ISBN and trims its fields', async () => {
  let requested, init;
  const upstream = async (url, options) => {
    requested = new URL(url);
    init = options;
    return Response.json({ items: [
      { id: 'other999', volumeInfo: { title: '別の本', industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780000000002' }] } },
      { id: 'gurigura1', volumeInfo: { title: 'ぐりとぐら', subtitle: '', authors: ['なかがわりえこ'], publisher: '福音館書店',
        publishedDate: '1967', imageLinks: { thumbnail: 'http://books.google.com/x' },
        industryIdentifiers: [{ type: 'ISBN_10', identifier: '4834000826' }] } },
    ] });
  };
  const found = await lookupBook('4834000826', { GOOGLE_BOOKS_API_KEY: 'k' }, upstream);
  assert.deepEqual(found.value, { found: true, isbn: '9784834000825', title: 'ぐりとぐら', authors: ['なかがわりえこ'],
    publisher: '福音館書店', publishedDate: '1967', volumeId: 'gurigura1', hasCover: true });
  assert.equal(requested.origin + requested.pathname, 'https://www.googleapis.com/books/v1/volumes');
  assert.equal(requested.searchParams.get('q'), 'isbn:9784834000825');
  // The key goes in a header: never in the URL, which is also the edge cache key.
  assert.equal(requested.searchParams.has('key'), false);
  assert.equal(init.headers['X-Goog-Api-Key'], 'k');
  assert.deepEqual(init.cf.cacheTtlByStatus, { '200-299': 86400, '300-599': 0 });
  assert.equal(requested.searchParams.get('country'), 'JP');

  assert.deepEqual((await lookupBook('9784834000825', {}, async () => Response.json({}))).value, { found: false, isbn: '9784834000825' });
  assert.equal((await lookupBook('9784834000825', {}, async () => new Response('', { status: 429 }))).error.status, 503);
  const google = (status, reason, message) => async () => Response.json({ error: { code: status, message,
    errors: [{ reason: 'x' }], details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } }, { status });
  const said = async (env, reply) => (await lookupBook('9784834000825', env, reply)).error.message;
  assert.match(await said({ GOOGLE_BOOKS_API_KEY: 'bad' }, google(400, 'API_KEY_INVALID', 'API key not valid. Please pass a valid API key.')), /APIキーが無効/);
  assert.match(await said({ GOOGLE_BOOKS_API_KEY: 'k' }, google(403, 'SERVICE_DISABLED', 'Books API has not been used in project 1 before or it is disabled.')), /Books APIが有効になっていません/);
  assert.match(await said({ GOOGLE_BOOKS_API_KEY: 'k' }, google(403, 'API_KEY_HTTP_REFERRER_BLOCKED', 'Requests from referer <empty> are blocked.')), /キーの制限/);
  assert.match(await said({}, google(429, 'RATE_LIMIT_EXCEEDED', 'Quota exceeded')), /APIキー（GOOGLE_BOOKS_API_KEY）が設定されていません/);
  assert.match(await said({ GOOGLE_BOOKS_API_KEY: 'k' }, google(429, 'RATE_LIMIT_EXCEEDED', 'Quota exceeded')), /^Google Booksの利用上限に達しました。時間をおく/);
  assert.match(explain(500, { code: '', message: '' }, true), /（500）/);
  assert.equal((await lookupBook('9784834000825', {}, async () => { throw Error('offline'); })).error.status, 503);
  assert.equal((await lookupBook('12345', {})).error.status, 400);
});

test('covers come only from the fixed Google Books URL and must be images', async () => {
  let requested;
  const image = async url => { requested = new URL(url); return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } }); };
  const cover = await fetchCover('gurigura1', image);
  assert.equal(cover.type, 'image/jpeg');
  assert.equal(requested.origin + requested.pathname, 'https://books.google.com/books/content');
  assert.equal(requested.searchParams.get('id'), 'gurigura1');
  assert.equal(await fetchCover('../../etc', image), null);
  assert.equal(await fetchCover('gurigura1', async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })), null);
});

const origin = 'https://homes.example.test';
const raw = 's'.repeat(43);
function fixture() {
  const calls = [];
  const env = {
    HOMES_AUTH_ORIGIN: origin, GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's',
    HOMES_OWNER_EMAIL: 'allowed@example.test', HOMES_OWNER_SUB: 'google-owner',
    HOME_STORE: { idFromName: n => n, get: () => ({
      read: async kind => { calls.push(['read', kind]); return { value: { ...shelf(), revision: 4 } }; },
      putBooks: async (body, actor) => { calls.push(['putBooks', actor]); return { value: { ...body, revision: body.revision + 1 } }; },
    }) },
    AUTH_STORE: { idFromName: n => n, get: () => ({ readSession: async () => ({ email: 'allowed@example.test', sub: 'google-owner' }) }) },
  };
  const app = createApp();
  const call = (path, init = {}) => app.fetch(new Request(origin + path, { ...init, headers: { Cookie: '__Host-homes-session=' + raw, ...init.headers } }), env);
  return { call, calls };
}

test('bookshelf API: document, lookup and cover routes on the signed-in origin', async () => {
  const f = fixture();
  const got = await f.call('/api/books');
  assert.equal(got.status, 200);
  assert.equal((await got.json()).revision, 4);
  assert.deepEqual(f.calls[0], ['read', 'books']);
  const put = await f.call('/api/books', { method: 'PUT', body: JSON.stringify({ ...shelf(), revision: 4 }),
    headers: { Origin: origin, 'Content-Type': 'application/json' } });
  assert.equal(put.status, 200);
  assert.equal(f.calls[1][0], 'putBooks');
  assert.equal((await f.call('/api/books', { method: 'PUT', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await f.call('/api/books?x=1')).status, 400);
  assert.equal((await f.call('/api/books/lookup?isbn=abc')).status, 400);
  assert.equal((await f.call('/api/books/lookup?isbn=9784834000825&key=x')).status, 400);
  assert.equal((await f.call('/api/books/cover?id=../x')).status, 400);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).startsWith('https://books.google.com/')
    ? new Response(new Uint8Array([9]), { headers: { 'Content-Type': 'image/png' } })
    : Response.json({ items: [{ id: 'gurigura1', volumeInfo: { title: 'ぐりとぐら', industryIdentifiers: [{ type: 'ISBN_13', identifier: '9784834000825' }] } }] });
  try {
    const lookup = await f.call('/api/books/lookup?isbn=9784834000825');
    assert.equal(lookup.status, 200);
    assert.equal((await lookup.json()).title, 'ぐりとぐら');
    const cover = await f.call('/api/books/cover?id=gurigura1');
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get('Content-Type'), 'image/png');
    assert.equal(cover.headers.get('Cache-Control'), 'private, max-age=604800');
  } finally { globalThis.fetch = realFetch; }

  const anonymous = await createApp().fetch(new Request(origin + '/api/books/cover?id=gurigura1'), {});
  assert.notEqual(anonymous.status, 200);
});

test('Books lookup falls back on a quota denial and returns the exact NDL record without a cover', async () => {
  const isbn = '9784577016961';
  const link = 'https://ndlsearch.ndl.go.jp/books/R100000002-I000002537579';
  const rss = `<rss><channel><item><title>別の本</title><link>${link}</link>
    <dc:identifier xsi:type="dcndl:ISBN">9784834000825</dc:identifier></item>
    <item><title>アンパンマンとまほうのふで</title><link>${link}</link>
    <description><![CDATA[<p>text</p>]]></description>
    <dc:creator>やなせたかし</dc:creator><dc:publisher>フレーベル館</dc:publisher>
    <dcterms:issued>1996.10</dcterms:issued>
    <dc:identifier xsi:type="dcndl:ISBN">4-577-01696-6</dc:identifier></item></channel></rss>`;
  const calls = [];
  const result = await lookupBook(isbn, { GOOGLE_BOOKS_API_KEY: 'test-key' }, async (url, init) => {
    calls.push(url.hostname);
    if (url.hostname === 'www.googleapis.com') return Response.json({}, { status: 429 });
    assert.equal(url.href, 'https://ndlsearch.ndl.go.jp/api/opensearch?isbn=' + isbn);
    assert.equal(init.headers['X-Goog-Api-Key'], undefined);
    assert.equal(init.redirect, 'error');
    return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml' } });
  });
  assert.deepEqual(calls, ['www.googleapis.com', 'ndlsearch.ndl.go.jp']);
  assert.deepEqual(result.value, { found: true, isbn, title: 'アンパンマンとまほうのふで',
    authors: ['やなせたかし'], publisher: 'フレーベル館', publishedDate: '1996-10',
    volumeId: '', hasCover: false, source: 'ndl' });
});

test('Books lookup does not silently use a different Google ISBN or a third-party NDL record', async () => {
  const isbn = '9784577016961';
  const result = await lookupBook(isbn, {}, async url => url.hostname === 'www.googleapis.com'
    ? Response.json({ items: [{ id: 'notexact', volumeInfo: { title: '別の版' } }] })
    : new Response(`<rss><channel><item><title>別機関の本</title>
      <link>https://ndlsearch.ndl.go.jp/books/R100000001-I123</link>
      <dc:identifier xsi:type="dcndl:ISBN">${isbn}</dc:identifier></item></channel></rss>`,
    { headers: { 'Content-Type': 'application/rss+xml' } }));
  assert.deepEqual(result.value, { found: false, isbn });
});

test('provider failure diagnostics disclose only a stable status when both services fail', async () => {
  const result = await lookupBook('9784577016961', {}, async url => url.hostname === 'www.googleapis.com'
    ? Response.json({}, { status: 429 })
    : new Response('Do not disclose upstream body', { status: 403 }));
  assert.equal(result.error.status, 503);
  assert.equal(result.ndlStatus, 'http-403');
  assert.ok(!JSON.stringify(result).includes('Do not disclose'));
});
