// Server-side rules for the Works ToDo and Memo documents, adapted for Homes.
// Ported from ryoxsakai/works worker/src (index.js todo section, todo-planner.js,
// memo.js). Student links, lesson sources and Google integrations are removed.
// Homes additionally records which family member created, last changed and
// completed each task; clients can never set those fields themselves.
import { addDays, dayAt, defaults, nextDay, palette, isHexColor, statusOf, validDay, validTime } from '../public/todo/model.mjs';

export const MAX_DOCUMENT_BYTES = 1_500_000;
export const ACTOR_FIELDS = ['createdBy', 'updatedBy', 'completedBy'];
const ROLE_ICONS = ['📚', '👥', '📝', '🏠', '💼', '⭐'];
const roleColor = /^(blue|green|pink|purple|yellow|#[0-9a-fA-F]{6})$/;

export const failure = (status, message) => Object.assign(new Error(message), { status });
const reject = message => { throw failure(400, message); };
const text = (s, limit) => typeof s === 'string' && s.trim().length > 0 && s.length <= limit;
const array = (a, max) => Array.isArray(a) && a.length <= max;
const todoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const actorOK = v => v === undefined || v === null || (typeof v === 'string' && v.length > 0 && v.length <= 40);

export const emptyTodo = () => ({ tasks: [], categories: ['家事', '買い物', 'その他'], roles: [] });
export const emptyMemo = () => ({ memos: [], categories: ['日常', '買い物', 'アイデア'] });

export function validateTodo(state) {
  const roles = state?.roles ?? [];
  const validRoles = Array.isArray(roles) && roles.length <= 200 && roles.every(r =>
    r && typeof r.id === 'string' && r.id && typeof r.name === 'string' && r.name.trim() && r.name.length <= 100 &&
    typeof r.color === 'string' && roleColor.test(r.color) && ROLE_ICONS.includes(r.icon) && typeof r.archived === 'boolean') &&
    new Set(roles.map(r => r.id)).size === roles.length;
  if (!validRoles || !state || !Array.isArray(state.tasks) || !Array.isArray(state.categories) ||
      state.tasks.length > 10000 || state.categories.length > 200 ||
      new Set(state.categories).size !== state.categories.length ||
      state.tasks.some(t => !t || typeof t.id !== 'string' || !t.id || t.id.length > 120 ||
        typeof t.name !== 'string' || !t.name.trim() || t.name.length > 500 ||
        typeof t.category !== 'string' || t.category.length > 100 ||
        ![null, 1, 2, 3].includes(t.priority) || (t.deadline !== null && !todoDate(t.deadline)) ||
        !Number.isInteger(t.progress) || t.progress < 0 || t.progress > 100 ||
        typeof t.memo !== 'string' || t.memo.length > 10000 ||
        (t.reusableDescription !== undefined && (typeof t.reusableDescription !== 'string' || t.reusableDescription.length > 10000)) ||
        (t.plannedDay != null && !todoDate(t.plannedDay)) ||
        (t.status !== undefined && !['pending', 'doing', 'waiting', 'done'].includes(t.status)) ||
        (t.important !== undefined && typeof t.important !== 'boolean') ||
        (t.roleId != null && !roles.some(r => r.id === t.roleId)) ||
        ACTOR_FIELDS.some(k => !actorOK(t[k])) ||
        (t.checklist !== undefined && (!Array.isArray(t.checklist) || t.checklist.length > 200 ||
          t.checklist.some(c => !c || typeof c.id !== 'string' || !c.id || typeof c.text !== 'string' ||
            !c.text.trim() || c.text.length > 500 || typeof c.checked !== 'boolean') ||
          new Set(t.checklist.map(c => c.id)).size !== t.checklist.length))) ||
      new Set(state.tasks.map(t => t.id)).size !== state.tasks.length ||
      state.categories.some(c => typeof c !== 'string' || !c.trim() || c.length > 100))
    reject('ToDoの入力形式が不正です');
  return state;
}

function registry(items, kind) {
  if (!array(items, 1000)) reject(kind + 'の件数が上限を超えています');
  const ids = new Set();
  for (const item of items) {
    if (!item || !text(item.id, 120) || !text(item.name, 100) || ids.has(item.id)) reject(kind + 'が不正です');
    ids.add(item.id);
  }
  return ids;
}
function tree(items, parent, kind) {
  const byId = new Map(items.map(t => [t.id, t])), checked = new Set();
  for (const item of items) {
    let node = item;
    const path = new Set();
    while (node && !checked.has(node.id)) {
      if (path.has(node.id)) reject(kind + 'を循環させることはできません');
      path.add(node.id);
      const id = parent(node);
      if (id && !byId.has(id)) reject(kind + 'の親が見つかりません');
      node = byId.get(id);
    }
    for (const id of path) checked.add(id);
  }
}
function validatePlanner(state) {
  const p = state.planner;
  const projects = registry(p.projects, 'プロジェクト'), labels = registry(p.labels, 'ラベル');
  registry(p.filters, 'フィルター');
  if ([...p.projects, ...p.labels].some(({ color }) => typeof color !== 'string' || (!isHexColor(color) && !Object.hasOwn(palette, color))))
    reject('色を選び直してください');
  tree(p.projects, i => i.parent, 'プロジェクト');
  if (typeof p.calendar !== 'boolean' || (p.review && (!Number.isInteger(p.review.step) || p.review.step < 0 ||
      p.review.step > 2 || (p.review.last && !validDay(p.review.last))))) reject('設定が不正です');
  for (const f of p.filters) {
    if (typeof f.query !== 'string' || f.query.length > 500 || (f.label && !labels.has(f.label)) ||
        (f.status && !['pending', 'doing', 'waiting', 'done'].includes(f.status)) || (f.due && f.due !== 'week') ||
        (f.project && !projects.has(f.project)) || (f.priority && ![1, 2, 3, 4].includes(f.priority)))
      reject('絞り込み条件が不正です');
  }
  tree(state.tasks, t => t.plan?.parent, 'タスク');
  for (const task of state.tasks) {
    const a = task.plan;
    if (!a) continue;
    if ((a.project && !projects.has(a.project)) || (a.section && !text(a.section, 100)) ||
        (a.labels && (!array(a.labels, 100) || a.labels.some(id => !labels.has(id)) || new Set(a.labels).size !== a.labels.length)) ||
        (a.time && (!task.plannedDay || !validTime(a.time))) ||
        (a.duration != null && (!Number.isInteger(a.duration) || a.duration < 1 || a.duration > 1440)) ||
        (a.priority != null && ![1, 2, 3, 4].includes(a.priority)) ||
        (a.reminder && !(typeof a.reminder === 'string' && validDay(a.reminder.slice(0, 10)) && a.reminder[10] === 'T' && validTime(a.reminder.slice(11)))) ||
        (a.repeat && (!task.plannedDay || !['fixed', 'after'].includes(a.repeat.mode) || !Number.isInteger(a.repeat.days) || a.repeat.days < 1 || a.repeat.days > 3650)))
      reject('タスクの日付・分類・繰り返し設定を確認してください');
    // Homes has no student directory or lesson calendar to link to. The Works
    // planner always sends empty placeholders, which are dropped here.
    if (Array.isArray(a.students) && !a.students.length) delete a.students;
    if (a.source === null) delete a.source;
    if (a.students !== undefined || a.source !== undefined) reject('このToDoでは生徒・授業の紐付けは使えません');
  }
}

// Works' preparePlanner: carries plan data forward and issues the next repeat.
function preparePlanner(state, previous, now) {
  const day = dayAt(now);
  state.planner = { ...defaults(), ...(state.planner ?? previous.planner), calendar: false };
  const oldTasks = new Map(previous.tasks.map(t => [t.id, t]));
  const tasks = [...state.tasks];
  const taskIds = new Set(tasks.map(t => t.id));
  for (const t of tasks) {
    const old = oldTasks.get(t.id);
    if (old?.plan && t.plan === undefined) t.plan = { ...old.plan };
    if (!t.plan) continue;
    const plan = (t.plan = { ...t.plan });
    if (plan.parent && oldTasks.has(plan.parent) && !taskIds.has(plan.parent)) plan.parent = null;
    if (old && old.priority !== t.priority && plan.priority === old.plan?.priority) plan.priority = t.priority ? 4 - t.priority : 4;
    if (old?.plan?.repeatIssued) plan.repeatIssued = true;
    else delete plan.repeatIssued;
    if (JSON.stringify(withoutActors(t)) !== JSON.stringify(withoutActors(old))) plan.updatedDay = day;
    if (old && statusOf(old) !== 'done' && statusOf(t) === 'done' && plan.repeat && !plan.repeatIssued) {
      validatePlanner({ ...state, tasks: [...tasks] });
      const scheduled = nextDay(plan.repeat, t.plannedDay, day);
      const nextPlan = { ...plan, updatedDay: day };
      const gap = (Date.parse(scheduled) - Date.parse(t.plannedDay)) / 86400000;
      if (plan.reminder) nextPlan.reminder = addDays(plan.reminder.slice(0, 10), gap) + plan.reminder.slice(10);
      plan.repeatIssued = true;
      state.tasks.push({
        id: crypto.randomUUID(), name: t.name, category: t.category, roleId: t.roleId ?? null,
        status: 'pending', progress: 0, priority: t.priority, important: !!t.important,
        plannedDay: scheduled, deadline: t.deadline ? addDays(t.deadline, gap) : null,
        memo: '', reusableDescription: t.reusableDescription || '',
        checklist: (t.checklist || []).map(step => ({ ...step, checked: false })),
        createdAt: day, plan: nextPlan,
      });
    }
  }
  validatePlanner(state);
}

function withoutActors(task) {
  if (!task) return task;
  const copy = { ...task };
  for (const key of ACTOR_FIELDS) delete copy[key];
  if (copy.plan) { copy.plan = { ...copy.plan }; delete copy.plan.updatedDay; }
  return copy;
}

// The server, not the browser, decides attribution from the signed-in member.
export function attribute(tasks, previousTasks, actor) {
  const previous = new Map(previousTasks.map(t => [t.id, t]));
  for (const task of tasks) {
    const old = previous.get(task.id);
    const done = statusOf(task) === 'done';
    for (const key of ACTOR_FIELDS) delete task[key];
    if (!old) {
      task.createdBy = actor;
      task.updatedBy = actor;
      task.completedBy = done ? actor : null;
      continue;
    }
    task.createdBy = old.createdBy ?? null;
    const changed = JSON.stringify(withoutActors(task)) !== JSON.stringify(withoutActors(old));
    task.updatedBy = changed ? actor : old.updatedBy ?? null;
    const wasDone = statusOf(old) === 'done';
    task.completedBy = done === wasDone ? (done ? old.completedBy ?? null : null) : done ? actor : null;
  }
}

// Returns the next stored document, or throws {status} errors.
export function nextTodo(current, input, actor, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('ToDoの入力形式が不正です');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) reject('revision is required');
  if (input.revision !== current.revision) throw failure(409, '変更が競合しました。再読み込みしてください');
  const state = structuredClone({
    tasks: input.tasks, categories: input.categories, roles: input.roles ?? current.roles,
    ...(input.planner !== undefined && { planner: input.planner }),
  });
  if (!Array.isArray(state.tasks)) reject('ToDoの入力形式が不正です');
  if (state.planner || current.planner || state.tasks.some(t => t?.plan)) preparePlanner(state, current, now);
  attribute(state.tasks, current.tasks, actor);
  validateTodo(state);
  if (current.roles.some(r => !state.roles.some(next => next.id === r.id))) reject('役割は削除せずアーカイブしてください');
  return {
    tasks: state.tasks, categories: state.categories, roles: state.roles,
    ...(state.planner && { planner: state.planner }),
    cloneRequests: current.cloneRequests ?? {},
  };
}

const CLONE_REQUEST = /^[a-zA-Z0-9_-]{16,100}$/;
const MAX_RECEIPTS = 200;
export function cloneTodo(current, args, actor, now = Date.now()) {
  if (!args || typeof args.request_id !== 'string' || !CLONE_REQUEST.test(args.request_id)) reject('stable request_id is required');
  if (!todoDate(args.base_day) || !Number.isInteger(args.offset_days) || args.offset_days < 1 || args.offset_days > 3650)
    reject('未来の日数は1〜3650日で指定してください');
  if (args.deadline != null && !todoDate(args.deadline)) reject('invalid deadline');
  const target = addDays(args.base_day, args.offset_days);
  const signature = JSON.stringify([args.id, args.base_day, args.offset_days, args.deadline ?? null]);
  const receipt = current.cloneRequests?.[args.request_id];
  if (receipt) {
    if (receipt.signature !== signature) throw failure(409, 'request_id already used with different arguments');
    return { result: receipt.result };
  }
  const source = current.tasks.find(t => t.id === args.id);
  if (!source) throw failure(404, 'task not found');
  const task = {
    id: crypto.randomUUID(), name: source.name,
    ...(source.plan && { plan: { project: source.plan.project, section: source.plan.section, labels: source.plan.labels, priority: source.plan.priority } }),
    category: source.category, roleId: source.roleId ?? null, priority: source.priority, important: source.important ?? false,
    memo: source.reusableDescription ?? '', reusableDescription: source.reusableDescription ?? '',
    plannedDay: target, deadline: args.deadline ?? null, progress: 0, status: 'pending',
    checklist: (source.checklist || []).map(c => ({ id: crypto.randomUUID(), text: c.text, checked: false })),
    createdAt: dayAt(now), cloneSourceId: source.id,
    createdBy: actor, updatedBy: actor, completedBy: null,
  };
  if (task.plan) for (const key of Object.keys(task.plan)) if (task.plan[key] === undefined) delete task.plan[key];
  const state = structuredClone({ tasks: [...current.tasks, task], categories: current.categories, roles: current.roles, ...(current.planner && { planner: current.planner }) });
  if (state.planner) validatePlanner(state);
  validateTodo(state);
  const result = { task, request_id: args.request_id, plannedDay: target, revision: current.revision + 1 };
  // Keep only recent receipts so the document cannot grow without bound.
  const receipts = Object.entries({ ...current.cloneRequests, [args.request_id]: { signature, result } }).slice(-MAX_RECEIPTS);
  return { result, next: { ...state, cloneRequests: Object.fromEntries(receipts) } };
}

export function validateMemo(state) {
  const textOK = (v, max) => typeof v === 'string' && v.length <= max;
  const strings = (v, count, max) => Array.isArray(v) && v.length <= count && v.every(s => textOK(s, max));
  if (!state || !Array.isArray(state.memos) || state.memos.length > 10000 ||
      !strings(state.categories, 200, 100) || state.categories.some(c => !c.trim() || c === 'すべて') ||
      new Set(state.categories).size !== state.categories.length ||
      new Set(state.memos.map(m => m?.id)).size !== state.memos.length ||
      state.memos.some(m => !m || !textOK(m.id, 100) || !m.id || !textOK(m.title, 500) || !m.title.trim() ||
        !textOK(m.category, 100) || (m.category !== '' && !state.categories.includes(m.category)) ||
        !strings(m.bodies, 100, 100000) || m.bodies.length === 0 || !strings(m.notes, 100, 10000) ||
        !strings(m.tags, 100, 100) || !todoDate(m.createdAt) || !todoDate(m.updatedAt)))
    reject('メモの入力形式が不正です');
}

export function nextMemo(current, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('メモの入力形式が不正です');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) reject('revision is required');
  if (input.revision !== current.revision) throw failure(409, '別の画面で変更されています。再読み込みが必要です');
  const state = { memos: input.memos, categories: input.categories };
  validateMemo(state);
  return state;
}

// One-time conversion of the first Homes release (todos/notes tables).
export function migrateLegacy(todos, notes) {
  const todo = emptyTodo();
  todo.tasks = [...todos].reverse().map(row => ({
    id: row.id, name: row.title.slice(0, 500), category: 'その他', priority: null,
    deadline: row.due_date && todoDate(row.due_date) ? row.due_date : null,
    progress: row.completed === 1 ? 100 : 0, status: row.completed === 1 ? 'done' : 'pending',
    memo: '', createdAt: String(row.created_at).slice(0, 10), plannedDay: null,
    ...(row.completed === 1 && { completedAt: row.updated_at }),
    createdBy: row.created_by ?? null, updatedBy: row.updated_by ?? null, completedBy: row.completed === 1 ? row.completed_by ?? null : null,
  }));
  const memo = emptyMemo();
  memo.memos = notes.map(row => ({
    id: row.id, title: row.title.slice(0, 500), category: '', bodies: [row.body], notes: [], tags: [],
    createdAt: String(row.created_at).slice(0, 10), updatedAt: String(row.updated_at).slice(0, 10),
  }));
  return { todo, memo };
}
