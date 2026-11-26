// 家計 (household spending) for Homes: a rough, hand-entered picture of where money
// goes. 固定費 are standing monthly, bimonthly (隔月) or yearly costs; 外食・内食中食・コンビニ・生活雑貨
// are dated entries listed by month. Who entered what is decided by the server.
import { failure } from './state.mjs';
import { checkRevision, isDay, rememberDeleted } from './household.mjs';
import { isHexColor, palette } from '../public/todo/model.mjs';

export const SPENDING_KINDS = ['eatout', 'home', 'conbini', 'living'];
export const MAX_AMOUNT = 100_000_000;
const reject = message => { throw failure(400, message); };
const str = (v, max) => typeof v === 'string' && v.length <= max;
const filled = (v, max) => str(v, max) && v.trim().length > 0;
const actorOK = v => v === null || filled(v, 40);
const yen = (v, min) => Number.isSafeInteger(v) && v >= min && v <= MAX_AMOUNT;

export const MAX_TAGS = 50;
export const emptyKakeibo = () => ({ fixed: [], entries: [], tags: [] });

// Tag colours are optional and use the ToDo palette (a name such as "blue") or a custom #rrggbb.
const colorOK = c => c === null || (typeof c === 'string' && (Object.hasOwn(palette, c) || isHexColor(c)));
const tagsOK = (list, ids) => Array.isArray(list) && list.length <= 10 && new Set(list).size === list.length && list.every(id => ids.has(id));

export function validateKakeibo(state) {
  const tags = state?.tags;
  if (!Array.isArray(tags) || tags.length > MAX_TAGS ||
      tags.some(t => !t || !filled(t.id, 120) || !filled(t.name, 30) || !colorOK(t.color)) ||
      new Set(tags.map(t => t.id)).size !== tags.length || new Set(tags.map(t => t.name.trim())).size !== tags.length)
    reject('タグの入力内容を確認してください');
  const ids = new Set(tags.map(t => t.id));
  if (!Array.isArray(state.fixed) || !Array.isArray(state.entries) ||
      state.fixed.length > 200 || state.entries.length > 10000 ||
      new Set([...state.fixed, ...state.entries].map(i => i?.id)).size !== state.fixed.length + state.entries.length)
    reject('家計の入力形式が不正です');
  for (const f of state.fixed) {
    if (!f || !filled(f.id, 120) || !filled(f.name, 100) || !yen(f.amount, 0) ||
        !['monthly', 'bimonthly', 'yearly'].includes(f.cycle) || !str(f.memo, 200) || !actorOK(f.addedBy) ||
        !tagsOK(f.tags, ids) || typeof f.review !== 'boolean')
      reject('固定費の入力内容を確認してください');
  }
  for (const e of state.entries) {
    if (!e || !filled(e.id, 120) || !SPENDING_KINDS.includes(e.kind) || !isDay(e.date) ||
        !filled(e.place, 100) || !yen(e.amount, 1) || !str(e.memo, 200) || !actorOK(e.by) ||
        !tagsOK(e.tags, ids) || typeof e.review !== 'boolean')
      reject('支出の入力内容を確認してください');
  }
  return state;
}

// New rows are credited to the signed-in member; edits keep the original person.
// Restoring a just-deleted row (元に戻す) brings back who entered it.
export function nextKakeibo(current, input, actor) {
  checkRevision(current, input, '家計');
  const state = structuredClone({ fixed: input.fixed, entries: input.entries, tags: input.tags ?? current.tags ?? [] });
  if (!Array.isArray(state.fixed) || !Array.isArray(state.entries)) reject('家計の入力形式が不正です');
  // Rows saved before tags and 見直し existed get the empty defaults.
  for (const item of [...state.fixed, ...state.entries]) {
    if (!item || typeof item !== 'object') continue;
    item.tags ??= [];
    item.review ??= false;
  }
  if (Array.isArray(state.tags)) for (const t of state.tags) if (t && typeof t === 'object') t.color ??= null;
  const before = new Map([...(current.deleted ?? []), ...current.fixed, ...current.entries].map(i => [i.id, i]));
  for (const f of state.fixed) if (f && typeof f === 'object') f.addedBy = before.has(f.id) ? before.get(f.id).addedBy ?? null : actor;
  for (const e of state.entries) if (e && typeof e === 'object') e.by = before.has(e.id) ? before.get(e.id).by ?? null : actor;
  validateKakeibo(state);
  state.deleted = rememberDeleted({ ...current, liveItems: [...current.fixed, ...current.entries] },
    new Set([...state.fixed, ...state.entries].map(i => i.id)),
    i => ({ id: i.id, ...('by' in i ? { by: i.by ?? null } : { addedBy: i.addedBy ?? null }) }));
  return state;
}
