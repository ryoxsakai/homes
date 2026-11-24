import { DurableObject } from 'cloudflare:workers';
import { MAX_DOCUMENT_BYTES, cloneTodo, emptyMemo, emptyTodo, failure, migrateLegacy, nextMemo, nextTodo } from './state.mjs';

const KINDS = ['todo', 'memo'];
const empty = { todo: emptyTodo, memo: emptyMemo };

// One household document per service (Works' todo_state / memo_state model),
// each with a revision for optimistic concurrency. Every operation runs inside a
// single synchronous storage transaction, so check-and-write is atomic.
export class HomesDataStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Tables of the first Homes release stay readable for the one-time migration.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, completed INTEGER NOT NULL CHECK(completed IN (0,1)),
      due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL,
      created_by TEXT, updated_by TEXT, completed_by TEXT
    )`);
    ctx.storage.transactionSync(() => {
      const columns = new Set(this.sql.exec('PRAGMA table_info(todos)').toArray().map(row => row.name));
      for (const column of ['created_by', 'updated_by', 'completed_by']) {
        if (!columns.has(column)) this.sql.exec(`ALTER TABLE todos ADD COLUMN ${column} TEXT`);
      }
    });
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL
    )`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS documents (kind TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL)');
  }

  #ensureMigrated() {
    const present = this.sql.exec('SELECT COUNT(*) AS n FROM documents').one().n;
    if (present) return;
    const { todo, memo } = migrateLegacy(
      this.sql.exec('SELECT * FROM todos ORDER BY created_at DESC, id DESC').toArray(),
      this.sql.exec('SELECT * FROM notes ORDER BY updated_at DESC, id DESC').toArray(),
    );
    // Revision 0 means "never saved", exactly as in Works; migrated data starts at 1.
    const migrated = todo.tasks.length || memo.memos.length;
    this.sql.exec('INSERT INTO documents VALUES (?, ?, ?)', 'todo', JSON.stringify(todo), migrated ? 1 : 0);
    this.sql.exec('INSERT INTO documents VALUES (?, ?, ?)', 'memo', JSON.stringify(memo), migrated ? 1 : 0);
  }

  #read(kind) {
    if (!KINDS.includes(kind)) throw Error('Invalid document');
    this.#ensureMigrated();
    const row = this.sql.exec('SELECT data, revision FROM documents WHERE kind = ?', kind).toArray()[0];
    return row ? { ...empty[kind](), ...JSON.parse(row.data), revision: row.revision } : { ...empty[kind](), revision: 0 };
  }

  #write(kind, data, revision) {
    const json = JSON.stringify(data);
    if (new TextEncoder().encode(json).length > MAX_DOCUMENT_BYTES) throw failure(413, '保存容量の上限を超えています');
    this.sql.exec('INSERT INTO documents VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET data = excluded.data, revision = excluded.revision', kind, json, revision);
    return { ...data, revision };
  }

  #run(operation) {
    try {
      return this.ctx.storage.transactionSync(operation);
    } catch (error) {
      // Only deliberate validation/conflict errors are reported to the browser.
      if (error?.status) return { error: { status: error.status, message: error.message } };
      throw error;
    }
  }

  read(kind) {
    return this.#run(() => {
      const value = this.#read(kind);
      if (kind === 'todo') delete value.cloneRequests;
      return { value };
    });
  }

  putTodo(input, actor) {
    if (typeof actor !== 'string' || !actor) throw Error('Actor required');
    return this.#run(() => {
      const current = this.#read('todo');
      const saved = this.#write('todo', nextTodo(current, input, actor), current.revision + 1);
      delete saved.cloneRequests;
      return { value: saved };
    });
  }

  cloneTodo(args, actor) {
    if (typeof actor !== 'string' || !actor) throw Error('Actor required');
    return this.#run(() => {
      const current = this.#read('todo');
      const { result, next } = cloneTodo(current, args, actor);
      if (next) this.#write('todo', next, current.revision + 1);
      return { value: result };
    });
  }

  cloneResult(requestId) {
    return this.#run(() => ({ value: this.#read('todo').cloneRequests?.[requestId]?.result ?? { found: false } }));
  }

  putMemo(input) {
    return this.#run(() => {
      const current = this.#read('memo');
      return { value: this.#write('memo', nextMemo(current, input), current.revision + 1) };
    });
  }
}
