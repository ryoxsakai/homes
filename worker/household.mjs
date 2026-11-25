// 食料品 (grocery) and 掃除 (cleaning) for Homes, ported from ryoxsakai/grocery-checker
// and ryoxsakai/cleaning-checker. Each is one revisioned household document, like
// ToDo, Memo and the bookshelf. Who added, bought or cleaned something is decided
// here from the signed-in member, never by the browser.
import { failure } from './state.mjs';
import { addDays, dayAt } from '../public/todo/model.mjs';

const reject = message => { throw failure(400, message); };
const str = (v, max) => typeof v === 'string' && v.length <= max;
const filled = (v, max) => str(v, max) && v.trim().length > 0;
const names = (list, max, size) => Array.isArray(list) && list.length <= max &&
  list.every(v => filled(v, size)) && new Set(list).size === list.length;
const actorOK = v => v === null || filled(v, 40);
export const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const uniqueIds = list => new Set(list.map(i => i?.id)).size === list.length;

export const emptyGrocery = () => ({
  toBuy: [], purchased: [],
  categories: ['野菜', '肉・魚', '乳製品', '飲み物', '調味料', 'その他'],
});
export const emptyCleaning = () => ({
  items: [],
  categories: ['キッチン', 'バスルーム', 'リビング', 'トイレ', 'その他'],
});

function checkRevision(current, input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject(label + 'の入力形式が不正です');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) reject('revision is required');
  if (input.revision !== current.revision) throw failure(409, '別の画面で変更されています。再読み込みしてください');
}

export function validateGrocery(state) {
  const category = c => c === '' || state.categories.includes(c);
  if (!state || !Array.isArray(state.toBuy) || !Array.isArray(state.purchased) ||
      state.toBuy.length > 1000 || state.purchased.length > 3000 || !names(state.categories, 200, 50) ||
      !uniqueIds([...state.toBuy, ...state.purchased]))
    reject('食料品の入力形式が不正です');
  for (const i of state.toBuy) {
    if (!i || !filled(i.id, 120) || !filled(i.name, 200) || !category(i.category) ||
        !isDay(i.addedOn) || !actorOK(i.addedBy))
      reject('買うものの入力内容を確認してください');
  }
  for (const i of state.purchased) {
    if (!i || !filled(i.id, 120) || !filled(i.name, 200) || !category(i.category) ||
        !isDay(i.purchasedDate) || !(i.expiryDate === null || isDay(i.expiryDate)) ||
        !actorOK(i.addedBy) || !actorOK(i.purchasedBy))
      reject('買ったものの入力内容を確認してください');
  }
  return state;
}

// An item keeps its id when it moves from 買うもの to 買ったもの, so who added it carries over.
export function nextGrocery(current, input, actor) {
  checkRevision(current, input, '食料品');
  const state = structuredClone({ toBuy: input.toBuy, purchased: input.purchased, categories: input.categories });
  if (!Array.isArray(state.toBuy) || !Array.isArray(state.purchased)) reject('食料品の入力形式が不正です');
  const before = new Map([...current.toBuy, ...current.purchased].map(i => [i.id, i]));
  const wasBought = new Set(current.purchased.map(i => i.id));
  for (const item of state.toBuy) {
    if (!item || typeof item !== 'object') continue;
    item.addedBy = before.has(item.id) ? before.get(item.id).addedBy ?? null : actor;
  }
  for (const item of state.purchased) {
    if (!item || typeof item !== 'object') continue;
    const old = before.get(item.id);
    item.addedBy = old ? old.addedBy ?? null : actor;
    item.purchasedBy = wasBought.has(item.id) ? old.purchasedBy ?? null : actor;
  }
  validateGrocery(state);
  return state;
}

export function validateCleaning(state) {
  if (!state || !Array.isArray(state.items) || state.items.length > 500 ||
      !names(state.categories, 200, 50) || !uniqueIds(state.items))
    reject('掃除の入力形式が不正です');
  for (const i of state.items) {
    if (!i || !filled(i.id, 120) || !filled(i.place, 100) ||
        !(i.category === '' || state.categories.includes(i.category)) ||
        !Number.isInteger(i.frequency) || i.frequency < 1 || i.frequency > 365 ||
        !isDay(i.lastCleaned) || !actorOK(i.lastCleanedBy) ||
        !Array.isArray(i.history) || i.history.length > HISTORY ||
        i.history.some(h => !h || !isDay(h.day) || !actorOK(h.by)))
      reject('掃除場所の入力内容を確認してください');
  }
  return state;
}

// Whoever marks a place cleaned today (完了) is recorded, in a short server-kept
// history. Moving the date back to a day in that history (元に戻す) restores who
// cleaned then, instead of crediting the person who pressed undo. An older day typed
// in by hand, or an imported place, has no known cleaner. Days are Japan time.
const HISTORY = 10;
export function nextCleaning(current, input, actor, now = Date.now()) {
  const day = dayAt(now);
  checkRevision(current, input, '掃除');
  const state = structuredClone({ items: input.items, categories: input.categories });
  if (!Array.isArray(state.items)) reject('掃除の入力形式が不正です');
  const before = new Map(current.items.map(i => [i.id, i]));
  for (const item of state.items) {
    if (!item || typeof item !== 'object') continue;
    const old = before.get(item.id);
    let history = old ? (old.history ?? [{ day: old.lastCleaned, by: old.lastCleanedBy ?? null }]) : [];
    if (old && old.lastCleaned === item.lastCleaned) {
      item.lastCleanedBy = old.lastCleanedBy ?? null;
    } else {
      const at = old && item.lastCleaned < old.lastCleaned ? history.findIndex(h => h.day === item.lastCleaned) : -1;
      if (at >= 0) {
        item.lastCleanedBy = history[at].by;
        history = history.slice(0, at + 1);
      } else {
        // Today or yesterday (Japan time) counts as just cleaned, absorbing device clock and timezone gaps.
        item.lastCleanedBy = item.lastCleaned >= addDays(day, -1) ? actor : null;
        history = [...history.filter(h => h.day < item.lastCleaned), { day: item.lastCleaned, by: item.lastCleanedBy }].slice(-HISTORY);
      }
    }
    item.history = history;
    if (isDay(item.lastCleaned) && item.lastCleaned > addDays(day, 1)) reject('最後に掃除した日は今日以前にしてください');
  }
  validateCleaning(state);
  return state;
}

// ─── One-time import from the old 掃除チェッカー (Firebase Realtime Database) ───
// The URL is fixed: the browser cannot point the Worker anywhere else.
export const LEGACY_CLEANING_URL = 'https://cleaning-checker-cefc6-default-rtdb.asia-southeast1.firebasedatabase.app/cleaning-checker.json';
const listOf = v => Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [];

// Converts what the old app stored into Homes items; anything unusable is skipped.
export function convertLegacyCleaning(data) {
  const categories = [...new Set(listOf(data?.categories).filter(c => filled(c, 50)).map(c => c.trim()))].slice(0, 200);
  const items = [];
  for (const raw of listOf(data?.items)) {
    if (items.length >= 500) break;
    const place = typeof raw?.place === 'string' ? raw.place.trim().slice(0, 100) : '';
    const frequency = Math.min(365, Math.max(1, Number.parseInt(raw?.frequency, 10) || 7));
    if (!place || !isDay(raw?.lastCleaned)) continue;
    const category = typeof raw.category === 'string' ? raw.category.trim() : '';
    if (category && !categories.includes(category) && categories.length < 200) categories.push(category.slice(0, 50));
    items.push({ id: crypto.randomUUID(), place, category: categories.includes(category) ? category : '', frequency, lastCleaned: raw.lastCleaned, lastCleanedBy: null, history: [] });
  }
  return { items, categories };
}

export async function fetchLegacyCleaning(upstream = fetch) {
  let response;
  try {
    response = await upstream(LEGACY_CLEANING_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  } catch {
    return { error: { status: 503, message: '以前の掃除チェッカーに接続できませんでした' } };
  }
  if (!response.ok) return { error: { status: 503, message: `以前の掃除チェッカーを読み込めませんでした（${response.status}）` } };
  try {
    const text = await response.text();
    if (text.length > 1_000_000) return { error: { status: 503, message: '以前のデータが大きすぎます' } };
    return { value: convertLegacyCleaning(JSON.parse(text)) };
  } catch {
    return { error: { status: 503, message: '以前のデータを読み取れませんでした' } };
  }
}
