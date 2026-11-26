// 家計 (household spending) for Homes: a rough, hand-entered picture of where money
// goes. 固定費 are standing monthly or yearly costs; 外食・内食中食・コンビニ・生活雑貨
// are dated entries listed by month. Who entered what is decided by the server.
import { failure } from './state.mjs';
import { checkRevision, isDay, rememberDeleted } from './household.mjs';

export const SPENDING_KINDS = ['eatout', 'home', 'conbini', 'living'];
export const MAX_AMOUNT = 100_000_000;
const reject = message => { throw failure(400, message); };
const str = (v, max) => typeof v === 'string' && v.length <= max;
const filled = (v, max) => str(v, max) && v.trim().length > 0;
const actorOK = v => v === null || filled(v, 40);
const yen = (v, min) => Number.isSafeInteger(v) && v >= min && v <= MAX_AMOUNT;

export const emptyKakeibo = () => ({ fixed: [], entries: [] });

export function validateKakeibo(state) {
  if (!state || !Array.isArray(state.fixed) || !Array.isArray(state.entries) ||
      state.fixed.length > 200 || state.entries.length > 10000 ||
      new Set([...state.fixed, ...state.entries].map(i => i?.id)).size !== state.fixed.length + state.entries.length)
    reject('家計の入力形式が不正です');
  for (const f of state.fixed) {
    if (!f || !filled(f.id, 120) || !filled(f.name, 100) || !yen(f.amount, 0) ||
        !['monthly', 'yearly'].includes(f.cycle) || !str(f.memo, 200) || !actorOK(f.addedBy))
      reject('固定費の入力内容を確認してください');
  }
  for (const e of state.entries) {
    if (!e || !filled(e.id, 120) || !SPENDING_KINDS.includes(e.kind) || !isDay(e.date) ||
        !filled(e.place, 100) || !yen(e.amount, 1) || !str(e.memo, 200) || !actorOK(e.by))
      reject('支出の入力内容を確認してください');
  }
  return state;
}

// New rows are credited to the signed-in member; edits keep the original person.
// Restoring a just-deleted row (元に戻す) brings back who entered it.
export function nextKakeibo(current, input, actor) {
  checkRevision(current, input, '家計');
  const state = structuredClone({ fixed: input.fixed, entries: input.entries });
  if (!Array.isArray(state.fixed) || !Array.isArray(state.entries)) reject('家計の入力形式が不正です');
  const before = new Map([...(current.deleted ?? []), ...current.fixed, ...current.entries].map(i => [i.id, i]));
  for (const f of state.fixed) if (f && typeof f === 'object') f.addedBy = before.has(f.id) ? before.get(f.id).addedBy ?? null : actor;
  for (const e of state.entries) if (e && typeof e === 'object') e.by = before.has(e.id) ? before.get(e.id).by ?? null : actor;
  validateKakeibo(state);
  state.deleted = rememberDeleted({ ...current, liveItems: [...current.fixed, ...current.entries] },
    new Set([...state.fixed, ...state.entries].map(i => i.id)),
    i => ({ id: i.id, ...('by' in i ? { by: i.by ?? null } : { addedBy: i.addedBy ?? null }) }));
  return state;
}
