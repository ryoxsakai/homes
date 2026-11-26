import installIcon from './ui/Homes.png';
export { HomesDataStore } from './data-store.mjs';
import { DurableObject } from 'cloudflare:workers';
import { createApp, sec, sessionTTL, stateTTL } from './auth.mjs';

export class HomesAuthStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expiry INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, email TEXT NOT NULL, sub TEXT NOT NULL, expiry INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS session_avatars (key TEXT PRIMARY KEY, picture TEXT NOT NULL)');
    // Members added and display names set from the admin settings screen.
    this.sql.exec('CREATE TABLE IF NOT EXISTS added_members (email TEXT PRIMARY KEY, alias TEXT NOT NULL, sub TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS member_names (email TEXT PRIMARY KEY, alias TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pending_renames (id INTEGER PRIMARY KEY AUTOINCREMENT, from_alias TEXT NOT NULL, to_alias TEXT NOT NULL)');
  }
  async memberDirectory() {
    return {
      added: this.sql.exec('SELECT email, alias, sub FROM added_members ORDER BY rowid').toArray(),
      names: this.sql.exec('SELECT email, alias FROM member_names').toArray(),
    };
  }
  // Directory changes run synchronously (no await), so each check-and-write is atomic
  // in this Durable Object: two tabs cannot both take the same display name.
  // `base` is the secret's members as [{email, alias}], which only the Worker knows.
  #aliases(base) {
    const names = new Map(this.sql.exec('SELECT email, alias FROM member_names').toArray().map(r => [r.email, r.alias]));
    const all = new Map(base.map(m => [m.email, names.get(m.email) ?? m.alias]));
    for (const a of this.sql.exec('SELECT email, alias FROM added_members').toArray())
      if (!all.has(a.email)) all.set(a.email, names.get(a.email) ?? a.alias);
    return all;
  }
  #aliasProblem(all, email, alias) {
    if ([...all].some(([e, a]) => e !== email && a === alias)) return 'その表示名はほかの人が使っています';
    // A name still being moved away from in past records cannot be reused yet.
    if (this.sql.exec('SELECT 1 FROM pending_renames WHERE from_alias = ?', alias).toArray().length) return 'その表示名は前の名前変更を反映中です。少し待ってからお試しください';
    return null;
  }
  async addMember(email, alias, sub, base = []) {
    const all = this.#aliases(base);
    if (all.has(email)) return { error: 'このメールアドレスはすでに登録されています', status: 409 };
    const problem = this.#aliasProblem(all, email, alias);
    if (problem) return { error: problem, status: 400 };
    this.sql.exec('INSERT INTO added_members VALUES (?, ?, ?)', email, alias, sub);
    return { ok: true };
  }
  // Saves the new name and, in the same transaction, a pending task to move past
  // records from the old name. The task is removed only once that rewrite succeeds.
  async setMemberName(email, alias, base = []) {
    const all = this.#aliases(base);
    const from = all.get(email);
    if (from === undefined) return { error: 'メンバーが見つかりません', status: 404 };
    if (from === alias) return { ok: true };
    const problem = this.#aliasProblem(all, email, alias);
    if (problem) return { error: problem, status: 400 };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO member_names VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET alias = excluded.alias', email, alias);
      this.sql.exec('INSERT INTO pending_renames (from_alias, to_alias) VALUES (?, ?)', from, alias);
    });
    return { ok: true };
  }
  async pendingRenames() {
    return this.sql.exec('SELECT id, from_alias, to_alias FROM pending_renames ORDER BY id').toArray();
  }
  async finishRename(id) { this.sql.exec('DELETE FROM pending_renames WHERE id = ?', id); }
  // Removing a member also ends their sessions at once.
  async removeMember(email) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM added_members WHERE email = ?', email);
      this.sql.exec('DELETE FROM member_names WHERE email = ?', email);
      this.sql.exec('DELETE FROM session_avatars WHERE key IN (SELECT key FROM sessions WHERE email = ?)', email);
      this.sql.exec('DELETE FROM sessions WHERE email = ?', email);
    });
  }
  async putState(key, nonce, verifier) {
    this.sql.exec('DELETE FROM attempts WHERE expiry <= ?', sec());
    this.sql.exec('INSERT INTO attempts VALUES (?, ?, ?, ?)', key, nonce, verifier, sec() + stateTTL);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 600_000);
  }
  async takeState(key) {
    const row = this.sql.exec('DELETE FROM attempts WHERE key = ? RETURNING nonce, verifier, expiry', key).toArray()[0];
    return row?.expiry > sec() ? { nonce: row.nonce, verifier: row.verifier } : null;
  }
  async readSession(key) {
    const row = this.sql.exec('SELECT email, sub FROM sessions WHERE key = ? AND expiry > ?', key, sec()).toArray()[0];
    return row || null;
  }
  async readAvatar(key) {
    const row = this.sql.exec('SELECT sessions.email, sessions.sub, session_avatars.picture FROM sessions LEFT JOIN session_avatars USING (key) WHERE sessions.key = ? AND expiry > ?', key, sec()).toArray()[0];
    return row || null;
  }
  async removeSession(key) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM sessions WHERE key = ?', key);
      this.sql.exec('DELETE FROM session_avatars WHERE key = ?', key);
    });
  }
  async replaceSession(key, email, sub, oldKey, picture) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM sessions WHERE key = ? OR expiry <= ?', oldKey || '', sec());
      this.sql.exec('DELETE FROM session_avatars WHERE key NOT IN (SELECT key FROM sessions)');
      this.sql.exec('INSERT INTO sessions VALUES (?, ?, ?, ?)', key, email, sub, sec() + sessionTTL);
      if (picture) this.sql.exec('INSERT INTO session_avatars VALUES (?, ?)', key, picture);
    });
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 600_000);
  }
  async alarm() {
    this.sql.exec('DELETE FROM attempts WHERE expiry <= ?', sec());
    this.sql.exec('DELETE FROM sessions WHERE expiry <= ?', sec());
    this.sql.exec('DELETE FROM session_avatars WHERE key NOT IN (SELECT key FROM sessions)');
    const remaining = this.sql.exec('SELECT MIN(expiry) AS next FROM (SELECT expiry FROM attempts UNION ALL SELECT expiry FROM sessions)').one();
    if (remaining.next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, remaining.next * 1000));
  }
}

export default createApp({ installIcon });
