import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneTodo, emptyMemo, emptyTodo, migrateLegacy, nextMemo, nextTodo } from '../worker/state.mjs';

const NOW = Date.parse('2026-11-24T03:00:00Z');
const task = (id, extra = {}) => ({ id, name: 'タスク' + id, category: '家事', priority: null, deadline: null, progress: 0,
  memo: '', createdAt: '2026-11-24', plannedDay: null, status: 'pending', ...extra });
const save = (current, tasks, actor, extra = {}) => ({ ...nextTodo(current, { ...current, tasks, revision: current.revision, ...extra }, actor, NOW), revision: current.revision + 1 });

test('ToDo attribution is decided on the server from the signed-in member', () => {
  let doc = { ...emptyTodo(), revision: 0 };
  doc = save(doc, [task('a', { createdBy: 'spoof', completedBy: 'spoof' })], '家族A');
  assert.deepEqual([doc.tasks[0].createdBy, doc.tasks[0].updatedBy, doc.tasks[0].completedBy], ['家族A', '家族A', null]);
  // An unchanged task keeps its actors even if another member saves the document.
  doc = save(doc, [...structuredClone(doc.tasks), task('b')], '家族B');
  assert.deepEqual([doc.tasks[0].updatedBy, doc.tasks[1].createdBy], ['家族A', '家族B']);
  const done = structuredClone(doc.tasks);
  Object.assign(done[0], { status: 'done', progress: 100, updatedBy: 'spoof' });
  doc = save(doc, done, '家族B');
  assert.deepEqual([doc.tasks[0].createdBy, doc.tasks[0].updatedBy, doc.tasks[0].completedBy], ['家族A', '家族B', '家族B']);
  const reopened = structuredClone(doc.tasks);
  Object.assign(reopened[0], { status: 'pending', progress: 0 });
  doc = save(doc, reopened, '家族A');
  assert.equal(doc.tasks[0].completedBy, null);
});

test('stale revisions conflict and invalid or student-linked tasks are rejected', () => {
  const doc = { ...emptyTodo(), revision: 2 };
  assert.throws(() => nextTodo(doc, { ...doc, revision: 1 }, 'A'), { status: 409 });
  assert.throws(() => nextTodo(doc, { ...doc, revision: undefined }, 'A'), { status: 400 });
  assert.throws(() => nextTodo(doc, { ...doc, tasks: [task('a', { name: ' ' })] }, 'A'), { status: 400 });
  const planner = { projects: [], labels: [], filters: [], review: null, calendar: false };
  assert.throws(() => nextTodo(doc, { ...doc, planner, tasks: [task('a', { plan: { students: [{ id: 's', name: '生徒' }] } })] }, 'A'), { status: 400 });
  // The Works planner's empty placeholders are accepted and dropped.
  const saved = nextTodo(doc, { ...doc, planner, tasks: [task('a', { plan: { students: [], source: null, priority: 4 } })] }, 'A', NOW);
  assert.deepEqual(Object.keys(saved.tasks[0].plan).sort(), ['priority', 'updatedDay']);
  assert.equal(saved.planner.calendar, false);
});

test('completing a repeating task issues the next one, attributed to the member', () => {
  const planner = { projects: [], labels: [], filters: [], review: null, calendar: false };
  let doc = { ...emptyTodo(), planner, revision: 0 };
  doc = save(doc, [task('r', { plannedDay: '2026-11-24', plan: { repeat: { mode: 'fixed', days: 7 } } })], '家族A');
  const done = structuredClone(doc.tasks);
  Object.assign(done[0], { status: 'done', progress: 100 });
  doc = save(doc, done, '家族B');
  assert.equal(doc.tasks.length, 2);
  assert.deepEqual([doc.tasks[1].plannedDay, doc.tasks[1].createdBy, doc.tasks[0].completedBy], ['2026-12-01', '家族B', '家族B']);
});

test('clone requests are idempotent and keep the requester as creator', () => {
  const doc = { ...emptyTodo(), tasks: [task('a', { memo: '個人メモ', reusableDescription: '手順' })], revision: 4 };
  const args = { id: 'a', request_id: 'abcdefghijklmnop', base_day: '2026-11-24', offset_days: 3, deadline: null };
  const { result, next } = cloneTodo(doc, args, '家族A', NOW);
  assert.deepEqual([result.plannedDay, result.task.memo, result.task.createdBy, result.revision], ['2026-11-27', '手順', '家族A', 5]);
  assert.equal(next.tasks.length, 2);
  const again = cloneTodo({ ...next, revision: 5 }, args, '家族B', NOW);
  assert.equal(again.next, undefined);
  assert.equal(again.result.task.id, result.task.id);
  assert.throws(() => cloneTodo({ ...next, revision: 5 }, { ...args, offset_days: 4 }, 'A'), { status: 409 });
  assert.throws(() => cloneTodo(doc, { ...args, id: 'missing', request_id: 'zzzzzzzzzzzzzzzz' }, 'A'), { status: 404 });
});

test('memo documents follow the Works shape and revision contract', () => {
  const doc = { ...emptyMemo(), revision: 0 };
  const memo = { id: 'm', title: '買い物', category: '買い物', bodies: ['卵'], notes: [], tags: ['週末'], createdAt: '2026-11-24', updatedAt: '2026-11-24' };
  assert.deepEqual(nextMemo(doc, { ...doc, memos: [memo] }).memos, [memo]);
  assert.throws(() => nextMemo({ ...doc, revision: 1 }, { ...doc, memos: [memo] }), { status: 409 });
  assert.throws(() => nextMemo(doc, { ...doc, memos: [{ ...memo, category: '存在しない' }] }), { status: 400 });
  assert.throws(() => nextMemo(doc, { ...doc, memos: [{ ...memo, bodies: [] }] }), { status: 400 });
});

test('the first Homes release migrates into Works documents with its attribution', () => {
  const { todo, memo } = migrateLegacy(
    [{ id: 't2', title: '新しい', completed: 1, due_date: '2026-11-30', created_at: '2026-11-24T01:00:00Z', updated_at: '2026-11-24T02:00:00Z', created_by: 'A', updated_by: 'B', completed_by: 'B' },
     { id: 't1', title: '古い', completed: 0, due_date: null, created_at: '2026-11-23T01:00:00Z', updated_at: '2026-11-23T01:00:00Z', created_by: null, updated_by: null, completed_by: null }],
    [{ id: 'n1', title: 'メモ', body: '', created_at: '2026-11-22T00:00:00Z', updated_at: '2026-11-23T00:00:00Z' }]);
  assert.deepEqual(todo.tasks.map(t => [t.id, t.status, t.deadline, t.createdBy, t.completedBy]),
    [['t1', 'pending', null, null, null], ['t2', 'done', '2026-11-30', 'A', 'B']]);
  assert.deepEqual(memo.memos[0], { id: 'n1', title: 'メモ', category: '', bodies: [''], notes: [], tags: [], createdAt: '2026-11-22', updatedAt: '2026-11-23' });
  // Both converted documents pass the regular validators unchanged.
  assert.doesNotThrow(() => nextTodo({ ...todo, revision: 1 }, { ...todo, revision: 1 }, 'A', NOW));
  assert.doesNotThrow(() => nextMemo({ ...memo, revision: 1 }, { ...memo, revision: 1 }));
});
