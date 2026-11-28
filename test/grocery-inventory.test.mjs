import test from 'node:test';
import assert from 'node:assert/strict';
import { groceryItems, moveItem, readGrocery, swipeStep, shouldToggleBuy } from '../public/grocery/model.mjs';
import { nextGrocery } from '../worker/household.mjs';

const todo = (id = 't', category = '野菜') => ({ id, name: 'トマト', category, addedOn: '2026-11-20', addedBy: '家族A' });
const bought = () => ({ id: 'p', name: '牛乳', category: '飲み物', purchasedDate: '2026-11-21', expiryDate: '2026-11-29', purchasedBy: '家族B', addedBy: '家族A' });
const legacy = () => ({ toBuy: [todo()], purchased: [bought()], categories: ['野菜', '飲み物'], revision: 2 });

test('legacy records are projected as actionable inventory; dates, IDs and names are untouched', () => {
  const source = legacy();
  const snapshot = structuredClone(source);
  const state = readGrocery(source);
  assert.deepEqual(source, snapshot);
  const [todo, bought] = groceryItems(state);
  assert.deepEqual([todo.inStock, todo.buyChecked, todo.expiryEnabled], [false, true, false]);
  assert.deepEqual([bought.inStock, bought.buyChecked, bought.expiryEnabled, bought.expiryKind], [true, false, true, 'best-before']);
  assert.deepEqual(bought.item, source.purchased[0]);
});

test('order and availability/checks are independent and revisioned with expiry choices', () => {
  const current = legacy();
  const item = { ...current.toBuy[0], inStock: true, buyChecked: true, expiryEnabled: false, expiryKind: 'use-by', expiryDate: '2026-11-30' };
  const payload = { ...current, toBuy: [item], itemOrder: ['p', 't'] };
  const saved = nextGrocery(current, payload, '家族B');
  assert.deepEqual(saved.toBuy[0], item);
  assert.deepEqual(groceryItems(readGrocery(saved)).map(row => row.item.id), ['p', 't']);
  assert.throws(() => nextGrocery({ ...saved, revision: 3 }, payload, '家族B'), { status: 409 });
  for (const order of [['p'], ['p', 'p'], ['p', 'x']]) assert.throws(() => nextGrocery(current, { ...payload, itemOrder: order }, '家族B'), { status: 400 });
  assert.throws(() => nextGrocery(current, { ...payload, toBuy: [{ ...item, expiryEnabled: true, expiryDate: null }] }, '家族B'), { status: 400 });
});

test('legacy writer preserves new fields/order; confirmed purchase uses the signed-in actor', () => {
  const base = legacy();
  const current = { ...base, toBuy: [{ ...base.toBuy[0], inStock: true, buyChecked: false, expiryEnabled: false, expiryKind: 'use-by', expiryDate: '2026-11-29' }], itemOrder: ['p', 't'] };
  const legacyEdit = { ...base, toBuy: [todo(), todo('new')] };
  const saved = nextGrocery(current, legacyEdit, '家族B');
  assert.deepEqual(saved.itemOrder, ['p', 't', 'new']);
  assert.deepEqual(saved.toBuy[0], current.toBuy[0]);
  const explicit = { ...current, purchased: [{ ...current.purchased[0], inStock: true, buyChecked: false, purchasedBy: '偽名' }], markPurchased: 'p' };
  assert.equal(nextGrocery(current, explicit, '家族C').purchased[0].purchasedBy, '家族C');
  const moved = { ...base, toBuy: [], purchased: [{ ...base.purchased[0] }, { ...base.purchased[0], id: 't' }] };
  const oldPurchase = nextGrocery(current, moved, '家族C');
  assert.deepEqual(oldPurchase.itemOrder, ['p', 't']);
  assert.deepEqual([oldPurchase.purchased[1].inStock, oldPurchase.purchased[1].buyChecked, oldPurchase.purchased[1].purchasedBy], [true, false, '家族C']);
});

test('reorder swaps siblings without moving hidden categories and never accepts an invalid step', () => {
  assert.deepEqual(moveItem(['a','b','c','d'], ['a','c'], 'c', -1), ['c','b','a','d']);
  assert.equal(moveItem(['a','b'], ['a','b'], 'b', 1), null);
  assert.equal(moveItem(['a','b'], ['a','b'], 'a', 5), null);
});

test('a short right swipe changes the buy check once, with or without manual return', () => {
  const path = points => points.reduce((state, [x, y]) => swipeStep(state, x, y), {});
  assert.equal(shouldToggleBuy(path([[15,1], [52,3], [12,3]])), true);
  assert.equal(shouldToggleBuy(path([[15,1], [46,1]])), true);
  assert.equal(shouldToggleBuy(path([[55,1], [8,1], [50,1]])), true);
  for (const points of [
    [[4,1]], [[15,1], [31,1]], [[14,22], [60,42], [4,2]], [[-15,1], [50,1], [3,1]], [[55,5], [10,50]],
  ]) assert.equal(shouldToggleBuy(path(points)), false);
});
