import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyKakeibo, nextKakeibo, validateKakeibo } from '../worker/kakeibo.mjs';
import { renameActorFields } from '../worker/household.mjs';
import { adminIdentity, mergeMembers, readMembers, signedInMember } from '../worker/members.mjs';
import { createApp } from '../worker/auth.mjs';
import { portalResponse } from '../worker/portal.mjs';

const entry = (over = {}) => ({ id: 'e1', kind: 'eatout', date: '2026-11-20', place: '〇〇食堂', amount: 1200, memo: '', by: null, ...over });
const fixed = (over = {}) => ({ id: 'f1', name: '家賃', amount: 80000, cycle: 'monthly', memo: '', addedBy: null, ...over });
const kakeibo = (over = {}) => ({ ...emptyKakeibo(), fixed: [fixed()], entries: [entry()], ...over });

test('家計 documents are validated', () => {
  validateKakeibo(kakeibo());
  validateKakeibo(kakeibo({ fixed: [fixed({ amount: 0, cycle: 'yearly' })], entries: [entry({ kind: 'living', memo: '服' })] }));
  for (const bad of [
    { entries: [entry({ kind: 'travel' })] }, { entries: [entry({ amount: 0 })] }, { entries: [entry({ amount: 12.5 })] },
    { entries: [entry({ amount: 100_000_001 })] }, { entries: [entry({ date: '2026-11-31' })] }, { entries: [entry({ place: '' })] },
    { fixed: [fixed({ cycle: 'weekly' })] }, { fixed: [fixed({ id: 'e1' })] },
  ]) assert.throws(() => validateKakeibo(kakeibo(bad)), { status: 400 }, JSON.stringify(bad));
});

test('家計: the server records who entered each row, keeps it on edit and on delete-undo', () => {
  let k = { ...emptyKakeibo(), revision: 0 };
  k = { ...nextKakeibo(k, { ...kakeibo({ entries: [entry({ by: '偽名' })], fixed: [fixed()] }), revision: 0 }, '家族A'), revision: 1 };
  assert.deepEqual([k.entries[0].by, k.fixed[0].addedBy], ['家族A', '家族A']);
  k = { ...nextKakeibo(k, { ...k, entries: [{ ...k.entries[0], amount: 1500 }], revision: 1 }, '家族B'), revision: 2 };
  assert.equal(k.entries[0].by, '家族A');
  const removed = k.entries[0];
  k = { ...nextKakeibo(k, { ...k, entries: [], revision: 2 }, '家族B'), revision: 3 };
  k = { ...nextKakeibo(k, { ...k, entries: [removed], revision: 3 }, '家族B'), revision: 4 };
  assert.equal(k.entries[0].by, '家族A');
  assert.throws(() => nextKakeibo(k, { ...k, revision: 1 }, '家族A'), { status: 409 });
});

test('renaming a member rewrites recorded names in every kind of document', () => {
  const data = {
    tasks: [{ createdBy: '家族A', updatedBy: '家族B', completedBy: '家族A', name: '家族A' }],
    items: [{ lastCleanedBy: '家族A', history: [{ day: '2026-11-20', by: '家族A' }] }],
    entries: [{ by: '家族A', place: '家族A' }], deleted: [{ addedBy: '家族A' }],
  };
  assert.equal(renameActorFields(data, '家族A', 'ママ'), 6);
  assert.equal(data.tasks[0].name, '家族A');
  assert.equal(data.entries[0].place, '家族A');
  assert.deepEqual([data.tasks[0].createdBy, data.tasks[0].updatedBy, data.items[0].history[0].by], ['ママ', '家族B', 'ママ']);
});

const family = JSON.stringify([{ email: 'admin@gmail.com', alias: '家族A' }, { email: 'other@gmail.com', alias: '家族B' }]);

test('the administrator comes from HOMES_ADMIN_EMAIL, else the original owner setting', () => {
  assert.deepEqual(adminIdentity({ HOMES_ADMIN_EMAIL: 'Admin@Gmail.com', HOMES_OWNER_EMAIL: 'x@gmail.com' }), { email: 'admin@gmail.com', sub: null });
  assert.deepEqual(adminIdentity({ HOMES_OWNER_EMAIL: 'admin@gmail.com', HOMES_OWNER_SUB: 'sub-1' }), { email: 'admin@gmail.com', sub: 'sub-1' });
  assert.equal(adminIdentity({}), null);
  const env = { HOMES_FAMILY_MEMBERS: family, HOMES_OWNER_EMAIL: 'admin@gmail.com', HOMES_OWNER_SUB: 'sub-admin' };
  const members = mergeMembers(readMembers(env), { added: [{ email: 'new@gmail.com', alias: '祖母', sub: null }], names: [{ email: 'other@gmail.com', alias: 'パパ' }] }, env);
  assert.deepEqual([...members.values()].map(m => [m.alias, m.source, m.admin]), [['家族A', 'secret', true], ['パパ', 'secret', false], ['祖母', 'added', false]]);
  assert.equal(signedInMember({ email: 'admin@gmail.com', sub: 'sub-admin' }, members).admin, true);
  // The owner's Google account ID must also match when the owner setting names the admin.
  assert.equal(signedInMember({ email: 'admin@gmail.com', sub: 'someone-else' }, members).admin, false);
  assert.equal(signedInMember({ email: 'new@gmail.com', sub: 's' }, members).alias, '祖母');
  assert.equal(signedInMember({ email: 'nobody@gmail.com', sub: 's' }, members), null);
});

const origin = 'https://homes.example.test';
function fixture(session) {
  const calls = [];
  const directory = { added: [{ email: 'grandma@gmail.com', alias: '祖母', sub: null }], names: [] };
  const env = {
    HOMES_AUTH_ORIGIN: origin, GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's',
    HOMES_FAMILY_MEMBERS: family, HOMES_ADMIN_EMAIL: 'admin@gmail.com',
    AUTH_STORE: { idFromName: n => n, get: () => ({
      readSession: async () => session, memberDirectory: async () => structuredClone(directory),
      addMember: async (...a) => { calls.push(['add', ...a]); directory.added.push({ email: a[0], alias: a[1], sub: a[2] }); },
      setMemberName: async (...a) => { calls.push(['name', ...a]); },
      removeMember: async (...a) => { calls.push(['remove', ...a]); },
    }) },
    HOME_STORE: { idFromName: n => n, get: () => ({
      renameActor: async (...a) => { calls.push(['renameActor', ...a]); return { value: { changed: 1 } }; },
      read: async kind => ({ value: { ...emptyKakeibo(), revision: 0, kind } }),
    }) },
  };
  const app = createApp();
  const call = (path, method = 'GET', body) => app.fetch(new Request(origin + path, {
    method, headers: { Cookie: '__Host-homes-session=' + 's'.repeat(43), ...(method !== 'GET' && { Origin: origin, 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  }), env);
  return { call, calls };
}

test('settings API: admin only; add, rename (rewriting records) and remove members', async () => {
  const other = fixture({ email: 'other@gmail.com', sub: 's2' });
  assert.equal((await other.call('/api/settings/members')).status, 403);
  assert.equal((await other.call('/api/settings/members', 'POST', { email: 'x@gmail.com', alias: 'X' })).status, 403);
  assert.deepEqual(await (await other.call('/api/me')).json(), { name: '家族B', hasPicture: false, admin: false });
  assert.equal(other.calls.length, 0);

  const f = fixture({ email: 'admin@gmail.com', sub: 's1' });
  assert.equal((await (await f.call('/api/me')).json()).admin, true);
  const list = await (await f.call('/api/settings/members')).json();
  assert.deepEqual(list.members.map(m => [m.alias, m.source, m.admin]), [['家族A', 'secret', true], ['家族B', 'secret', false], ['祖母', 'added', false]]);

  assert.equal((await f.call('/api/settings/members', 'POST', { email: 'friend@example.com', alias: '友人' })).status, 400, 'non-Gmail needs a sub');
  assert.equal((await f.call('/api/settings/members', 'POST', { email: 'aunt@gmail.com', alias: '家族B' })).status, 400, 'names stay unique');
  assert.equal((await f.call('/api/settings/members', 'POST', { email: 'other@gmail.com', alias: 'Y' })).status, 409);
  const added = await f.call('/api/settings/members', 'POST', { email: 'Aunt@Gmail.com', alias: 'おば' });
  assert.equal(added.status, 200);
  assert.deepEqual(f.calls.at(-1), ['add', 'aunt@gmail.com', 'おば', null]);

  assert.equal((await f.call('/api/settings/members', 'PUT', { email: 'other@gmail.com', alias: 'パパ' })).status, 200);
  assert.deepEqual(f.calls.slice(-2), [['name', 'other@gmail.com', 'パパ'], ['renameActor', '家族B', 'パパ']]);
  assert.equal((await f.call('/api/settings/members', 'PUT', { email: 'other@gmail.com', alias: 'a@b' })).status, 400);

  assert.equal((await f.call('/api/settings/members', 'DELETE', { email: 'other@gmail.com' })).status, 400, 'secret members stay');
  assert.equal((await f.call('/api/settings/members', 'DELETE', { email: 'admin@gmail.com' })).status, 400);
  assert.equal((await f.call('/api/settings/members', 'DELETE', { email: 'grandma@gmail.com' })).status, 200);
  assert.deepEqual(f.calls.at(-1), ['remove', 'grandma@gmail.com']);
  // Cross-site writes are refused before reaching settings.
  const cross = await createApp().fetch(new Request(origin + '/api/settings/members', { method: 'POST', headers: { Cookie: '__Host-homes-session=' + 's'.repeat(43), Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' }), {});
  assert.notEqual(cross.status, 200);
});

test('a member added in settings can use Homes; 家計 is a household document', async () => {
  const f = fixture({ email: 'grandma@gmail.com', sub: 'g' });
  assert.deepEqual(await (await f.call('/api/me')).json(), { name: '祖母', hasPicture: false, admin: false });
  const k = await f.call('/api/kakeibo');
  assert.equal(k.status, 200);
  assert.equal((await k.json()).kind, 'kakeibo');
});

test('the settings page and its files are served only to the administrator', async () => {
  const assets = { fetch: async () => new Response('<p>settings</p>', { headers: { 'Content-Type': 'text/html' } }) };
  const respond = (status, body, options) => ({ status, body, options });
  const get = (path, member) => { const url = new URL(path, origin); return portalResponse(new Request(url), url, member, assets, respond); };
  assert.equal((await get('/settings/', { alias: '家族B', admin: false })).status, 404);
  assert.equal((await get('/settings/app.mjs', { alias: '家族B', admin: false })).status, 404);
  assert.equal((await get('/settings/', { alias: '家族A', admin: true })).status, 200);
  assert.equal((await get('/kakeibo/', { alias: '家族B', admin: false })).status, 200);
});
