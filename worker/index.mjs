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
