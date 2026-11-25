import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_CLEANING_URL, convertLegacyCleaning, emptyCleaning, emptyGrocery, fetchLegacyCleaning,
  importCleaning, nextCleaning, nextGrocery, validateCleaning, validateGrocery } from '../worker/household.mjs';
import { createApp } from '../worker/auth.mjs';

const toBuy = (over = {}) => ({ id: 't1', name: '牛乳', category: '乳製品', addedOn: '2026-11-20', addedBy: null, ...over });
const bought = (over = {}) => ({ id: 'p1', name: '卵', category: 'その他', purchasedDate: '2026-11-20', expiryDate: '2026-11-30', addedBy: null, purchasedBy: null, ...over });
const grocery = (over = {}) => ({ ...emptyGrocery(), toBuy: [toBuy()], purchased: [bought()], ...over });

test('grocery documents are validated against their own categories and dates', () => {
  validateGrocery(grocery());
  validateGrocery(grocery({ toBuy: [toBuy({ category: '' })], purchased: [bought({ expiryDate: null })] }));
  for (const bad of [
    { toBuy: [toBuy({ name: ' ' })] }, { toBuy: [toBuy({ category: '文房具' })] }, { toBuy: [toBuy({ addedOn: '11/20' })] },
    { purchased: [bought({ purchasedDate: '2026-02-30' })] }, { purchased: [bought({ expiryDate: '' })] },
    { purchased: [bought({ id: 't1' })] }, { categories: ['野菜', '野菜'] },
  ]) assert.throws(() => validateGrocery(grocery(bad)), { status: 400 }, JSON.stringify(bad));
});

test('grocery: the server records who added and who bought, and keeps the adder when bought', () => {
  const start = { ...emptyGrocery(), revision: 1 };
  const added = nextGrocery(start, { ...emptyGrocery(), toBuy: [toBuy({ addedBy: '偽名' })], revision: 1 }, '家族A');
  assert.equal(added.toBuy[0].addedBy, '家族A');
  const moved = nextGrocery({ ...added, revision: 2 }, { ...added, toBuy: [],
    purchased: [bought({ id: 't1', name: '牛乳', category: '乳製品', purchasedBy: '偽名' })], revision: 2 }, '家族B');
  assert.deepEqual([moved.purchased[0].addedBy, moved.purchased[0].purchasedBy], ['家族A', '家族B']);
  const edited = nextGrocery({ ...moved, revision: 3 }, { ...moved, purchased: [{ ...moved.purchased[0], expiryDate: '2026-12-01' }], revision: 3 }, '家族A');
  assert.equal(edited.purchased[0].purchasedBy, '家族B');
  assert.throws(() => nextGrocery({ ...moved, revision: 3 }, { ...moved, revision: 2 }, '家族A'), { status: 409 });
});

const place = (over = {}) => ({ id: 'c1', place: 'シンク', category: 'キッチン', frequency: 7, lastCleaned: '2026-11-20', lastCleanedBy: null, history: [], ...over });
const NOW = Date.parse('2026-11-25T03:00:00Z'); // 2026-11-25 12:00 in Japan

test('cleaning documents are validated', () => {
  validateCleaning({ ...emptyCleaning(), items: [place()] });
  for (const bad of [{ frequency: 0 }, { frequency: 366 }, { frequency: 1.5 }, { place: '' }, { category: '庭' },
    { lastCleaned: '2026-13-01' }, { history: [{ day: 'x', by: null }] }])
    assert.throws(() => validateCleaning({ ...emptyCleaning(), items: [place(bad)] }), { status: 400 }, JSON.stringify(bad));
});

test('cleaning: 完了 records the cleaner, undo restores the earlier cleaner, past days stay unattributed', () => {
  const doc = (items, revision) => ({ ...emptyCleaning(), items, revision });
  // Added with a past date: nobody is credited.
  let current = { ...nextCleaning(doc([], 0), doc([place()], 0), '家族A', NOW), revision: 1 };
  assert.equal(current.items[0].lastCleanedBy, null);
  // 完了 today by 家族B.
  current = { ...nextCleaning(current, doc([{ ...current.items[0], lastCleaned: '2026-11-25' }], 1), '家族B', NOW), revision: 2 };
  assert.equal(current.items[0].lastCleanedBy, '家族B');
  // 完了 again the next day by 家族A, then 家族B presses 元に戻す.
  const tomorrow = NOW + 86400000;
  current = { ...nextCleaning(current, doc([{ ...current.items[0], lastCleaned: '2026-11-26' }], 2), '家族A', tomorrow), revision: 3 };
  assert.equal(current.items[0].lastCleanedBy, '家族A');
  current = { ...nextCleaning(current, doc([{ ...current.items[0], lastCleaned: '2026-11-25', lastCleanedBy: '偽名' }], 3), '家族B', tomorrow), revision: 4 };
  assert.equal(current.items[0].lastCleanedBy, '家族B');
  assert.deepEqual(current.items[0].history.map(h => h.day), ['2026-11-20', '2026-11-25']);
  // Editing the frequency keeps the cleaner.
  current = { ...nextCleaning(current, doc([{ ...current.items[0], frequency: 3 }], 4), '家族A', tomorrow), revision: 5 };
  assert.equal(current.items[0].lastCleanedBy, '家族B');
  assert.throws(() => nextCleaning(current, doc([{ ...current.items[0], lastCleaned: '2026-12-30' }], 5), '家族A', tomorrow), { status: 400 });
});

test('undoing a deletion restores who added, bought and cleaned', () => {
  // Grocery: 家族A added, 家族B bought; 家族C deletes it, then presses 元に戻す.
  let g = { ...emptyGrocery(), toBuy: [toBuy({ addedBy: '家族A' })], purchased: [bought({ addedBy: '家族A', purchasedBy: '家族B' })], revision: 1 };
  const kept = { toBuy: g.toBuy, purchased: g.purchased };
  g = { ...nextGrocery(g, { ...g, toBuy: [], purchased: [], revision: 1 }, '家族C'), revision: 2 };
  assert.deepEqual(g.deleted.map(d => d.id), ['t1', 'p1']);
  g = { ...nextGrocery(g, { ...g, ...kept, revision: 2 }, '家族C'), revision: 3 };
  assert.equal(g.toBuy[0].addedBy, '家族A');
  assert.deepEqual([g.purchased[0].addedBy, g.purchased[0].purchasedBy], ['家族A', '家族B']);
  assert.deepEqual(g.deleted, []);
  // Cleaning: the cleaner and history come back too.
  const cleaned = place({ lastCleanedBy: '家族B', history: [{ day: '2026-11-20', by: '家族B' }] });
  let c = { ...emptyCleaning(), items: [cleaned], revision: 1 };
  c = { ...nextCleaning(c, { ...c, items: [], revision: 1 }, '家族C', NOW), revision: 2 };
  c = { ...nextCleaning(c, { ...c, items: [{ ...cleaned, lastCleanedBy: null, history: [] }], revision: 2 }, '家族C', NOW), revision: 3 };
  assert.equal(c.items[0].lastCleanedBy, '家族B');
  assert.deepEqual(c.items[0].history, cleaned.history);
});

test('imported cleaning places are never credited, even if cleaned today', () => {
  const legacy = { items: [place({ id: 'i1', lastCleaned: '2026-11-25' })], categories: ['ベランダ'] };
  const imported = importCleaning({ ...emptyCleaning(), revision: 0 }, legacy);
  assert.equal(imported.items[0].lastCleanedBy, null);
  assert.ok(imported.categories.includes('ベランダ'));
  assert.throws(() => importCleaning({ ...emptyCleaning(), items: [place()], revision: 1 }, legacy), { status: 409 });
  assert.throws(() => importCleaning({ ...emptyCleaning(), revision: 0 }, { items: [], categories: [] }), { status: 404 });
  // A normal save afterwards keeps the import unattributed.
  const after = nextCleaning({ ...imported, revision: 1 }, { ...imported, revision: 1 }, '家族A', NOW);
  assert.equal(after.items[0].lastCleanedBy, null);
});

test('the old 掃除チェッカー data converts into Homes places', async () => {
  const converted = convertLegacyCleaning({
    categories: ['キッチン', 'バスルーム'],
    items: { a: { id: '1', place: 'シンク', category: 'キッチン', frequency: 7, lastCleaned: '2026-11-01' },
      b: { place: 'ベランダ', category: '外', frequency: '30', lastCleaned: '2026-10-01' },
      c: { place: '', frequency: 7, lastCleaned: '2026-11-01' }, d: { place: '窓', lastCleaned: 'yesterday' } },
  });
  assert.deepEqual(converted.categories, ['キッチン', 'バスルーム', '外']);
  assert.deepEqual(converted.items.map(i => [i.place, i.category, i.frequency, i.lastCleaned, i.lastCleanedBy]),
    [['シンク', 'キッチン', 7, '2026-11-01', null], ['ベランダ', '外', 30, '2026-10-01', null]]);
  validateCleaning({ ...converted });
  let requested;
  const found = await fetchLegacyCleaning(async url => { requested = url; return Response.json({ items: [{ place: 'トイレ', frequency: 3, lastCleaned: '2026-11-20' }] }); });
  assert.equal(requested, LEGACY_CLEANING_URL);
  assert.equal(found.value.items[0].place, 'トイレ');
  assert.equal((await fetchLegacyCleaning(async () => new Response('', { status: 401 }))).error.status, 503);
  assert.deepEqual((await fetchLegacyCleaning(async () => Response.json(null))).value.items, []);
});

const origin = 'https://homes.example.test';
function fixture() {
  const calls = [];
  const env = {
    HOMES_AUTH_ORIGIN: origin, GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's',
    HOMES_OWNER_EMAIL: 'allowed@example.test', HOMES_OWNER_SUB: 'google-owner',
    HOME_STORE: { idFromName: n => n, get: () => ({
      read: async kind => { calls.push(['read', kind]); return { value: { revision: 2 } }; },
      putHousehold: async (kind, body, actor) => { calls.push(['put', kind, actor]); return { value: { revision: body.revision + 1 } }; },
      importCleaning: async legacy => { calls.push(['import', legacy.items.length]); return { value: { items: legacy.items, categories: [], revision: 3 } }; },
    }) },
    AUTH_STORE: { idFromName: n => n, get: () => ({ readSession: async () => ({ email: 'allowed@example.test', sub: 'google-owner' }) }) },
  };
  const app = createApp();
  const call = (path, init = {}) => app.fetch(new Request(origin + path, { ...init, headers: { Cookie: '__Host-homes-session=' + 's'.repeat(43), ...init.headers } }), env);
  return { call, calls };
}

test('household API: grocery and cleaning documents and the legacy import route', async () => {
  const f = fixture();
  for (const kind of ['grocery', 'cleaning']) {
    assert.equal((await f.call(`/api/${kind}`)).status, 200);
    const put = await f.call(`/api/${kind}`, { method: 'PUT', body: JSON.stringify({ revision: 2 }), headers: { Origin: origin, 'Content-Type': 'application/json' } });
    assert.equal(put.status, 200);
    assert.equal((await f.call(`/api/${kind}`, { method: 'PUT', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await f.call(`/api/${kind}?x=1`)).status, 400);
  }
  assert.deepEqual(f.calls.map(c => c.slice(0, 2)), [['read', 'grocery'], ['put', 'grocery'], ['read', 'cleaning'], ['put', 'cleaning']]);
  // The actor is the signed-in member's display name, never a value from the request.
  assert.ok(typeof f.calls[1][2] === 'string' && f.calls[1][2].length > 0);
  assert.equal((await f.call('/api/cleaning/legacy', { method: 'POST', headers: { Origin: origin } })).status, 405);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ items: [{ place: 'シンク', frequency: 7, lastCleaned: '2026-11-20' }] });
  try {
    const legacy = await f.call('/api/cleaning/legacy');
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).items[0].place, 'シンク');
    assert.equal((await f.call('/api/cleaning/import', { method: 'POST' })).status, 403);
    const imported = await f.call('/api/cleaning/import', { method: 'POST', headers: { Origin: origin } });
    assert.equal(imported.status, 200);
    assert.deepEqual(f.calls.at(-1), ['import', 1]);
  } finally { globalThis.fetch = realFetch; }
  const anonymous = await createApp().fetch(new Request(origin + '/api/cleaning/legacy'), {});
  assert.notEqual(anonymous.status, 200);
});
