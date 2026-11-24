import { DurableObject } from 'cloudflare:workers';

const MAX_RECORDS = 200;

const todo = r => ({
  id:r.id, title:r.title, completed:r.completed === 1, dueDate:r.due_date,
  createdAt:r.created_at, updatedAt:r.updated_at, version:r.version,
  createdBy:r.created_by, updatedBy:r.updated_by, completedBy:r.completed_by,
});
const note = r => ({
  id:r.id, title:r.title, body:r.body, createdAt:r.created_at, updatedAt:r.updated_at, version:r.version,
});

export class HomesDataStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, completed INTEGER NOT NULL CHECK(completed IN (0,1)),
      due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL,
      created_by TEXT, updated_by TEXT, completed_by TEXT
    )`);
    // Old rows keep NULL rather than attributing activity that happened before this schema.
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
  }

  list() {
    return {
      todos: this.sql.exec('SELECT * FROM todos ORDER BY created_at DESC, id DESC').toArray().map(todo),
      notes: this.sql.exec('SELECT * FROM notes ORDER BY updated_at DESC, id DESC').toArray().map(note),
    };
  }

  mutate(kind, method, id, input, actor) {
    if (!['todos','notes'].includes(kind) || !['POST','PATCH','DELETE'].includes(method)) throw Error('Invalid operation');
    if (kind === 'todos' && (typeof actor !== 'string' || !actor)) throw Error('Actor required');
    const view = kind === 'todos' ? todo : note;
    const table = kind === 'todos' ? 'todos' : 'notes';
    const now = new Date().toISOString();
    // No awaits: quota, lookup, version check and operation form one atomic transaction.
    return this.ctx.storage.transactionSync(() => {
      if (method === 'POST') {
        if (this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n >= MAX_RECORDS) return {error:'quota_exceeded'};
        const key = crypto.randomUUID();
        const row = kind === 'todos'
          ? this.sql.exec('INSERT INTO todos (id,title,completed,due_date,created_at,updated_at,version,created_by,updated_by) VALUES (?, ?, 0, ?, ?, ?, 1, ?, ?) RETURNING *', key, input.title, input.dueDate ?? null, now, now, actor, actor).one()
          : this.sql.exec('INSERT INTO notes VALUES (?, ?, ?, ?, ?, 1) RETURNING *', key, input.title, input.body, now, now).one();
        return {record:view(row)};
      }
      const current = this.sql.exec(`SELECT * FROM ${table} WHERE id = ?`, id).toArray()[0];
      if (!current) return {error:'not_found'};
      if (current.version !== input.version) return {error:'version_conflict'};
      if (method === 'DELETE') {
        this.sql.exec(`DELETE FROM ${table} WHERE id = ?`, id);
        return {};
      }
      const completedActor = kind !== 'todos' || input.completed === undefined || Number(input.completed) === current.completed
        ? current.completed_by : input.completed ? actor : null;
      const next = kind === 'todos'
        ? this.sql.exec('UPDATE todos SET title=?, completed=?, due_date=?, updated_at=?, updated_by=?, completed_by=?, version=version+1 WHERE id=? RETURNING *',
          input.title ?? current.title, input.completed === undefined ? current.completed : Number(input.completed),
          input.dueDate === undefined ? current.due_date : input.dueDate, now, actor, completedActor, id).one()
        : this.sql.exec('UPDATE notes SET title=?, body=?, updated_at=?, version=version+1 WHERE id=? RETURNING *',
          input.title ?? current.title, input.body ?? current.body, now, id).one();
      return {record:view(next)};
    });
  }
}
