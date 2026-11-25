import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { readCoverChange, MAX_PHOTO_BASE64 } from '../worker/books-photos.mjs';
import { createApp } from '../worker/auth.mjs';

const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAlRXhpZgAAc2FtcGxlLXNlY3JldC1tZXRhZGF0YS1zb3VyY2X/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCAAIAAUDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCCiiivmj70/9k=';
const book = {
  id:'b1', title:'表紙のテスト', isbn:'', authors:[], publisher:'', publishedDate:'', volumeId:'', hasCover:false,
  status:'owned', location:'', category:'', tags:[], memo:'', createdAt:'2026-11-25', updatedAt:'2026-11-25', createdBy:null,
};

test('the paperback cover accepts only a bounded JPEG and strips metadata', () => {
  const { bytes } = readCoverChange({ id:'b1', jpeg }, [book]);
  assert.equal(Buffer.from(bytes).includes(Buffer.from('sample-secret-metadata-source')), false);
  assert.deepEqual([...new Uint8Array(bytes).slice(0, 2)], [255, 216]);
  assert.deepEqual([...new Uint8Array(bytes).slice(-2)], [255, 217]);
  assert.throws(() => readCoverChange({ id:'invented', jpeg }, [book]), {status:400});
  assert.throws(() => readCoverChange({ id:'b1', jpeg: 'PHN2Zz4=' }, [book]), {status:400});
  assert.throws(() => readCoverChange({ id:'b1', jpeg:'a'.repeat(MAX_PHOTO_BASE64 + 4) }, [book]), {status:413});
});

async function sqliteStore() {
  // Exercise the production SQL with real SQLite behind a minimal DO adapter.
  const source = (await readFile(new URL('../worker/data-store.mjs', import.meta.url), 'utf8'))
    .replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx) { this.ctx = ctx; } }')
    .replace(/from '\.\/([^']+)'/g, (_, filename) => `from '${new URL('../worker/' + filename, import.meta.url)}'`);
  const { HomesDataStore } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: {
      exec(query, ...args) {
        const statement = db.prepare(query);
        const params = args.map(a => a instanceof ArrayBuffer ? new Uint8Array(a) : a);
        if (!statement.columns().length) { statement.run(...params); return {toArray: () => []}; }
        return { toArray: () => statement.all(...params), one: () => statement.get(...params) };
      }
    },
    transactionSync(work) {
      db.exec('BEGIN');
      try { const result = work(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return new HomesDataStore({ storage }, {});
}

test('signed-in bookshelf photo saves atomically, stays private and can be removed', async () => {
  const store = await sqliteStore();
  const origin = 'https://homes.example.test';
  const raw = 's'.repeat(43);
  const env = {
    HOMES_AUTH_ORIGIN: origin, GOOGLE_CLIENT_ID:'client', GOOGLE_CLIENT_SECRET:'secret',
    HOMES_OWNER_EMAIL:'owner@gmail.com',
    AUTH_STORE: { idFromName:n => n, get:() => ({
      readSession:async () => ({ email:'owner@gmail.com', sub:'sub' }),
    }) },
    HOME_STORE: { idFromName:n => n, get:() => store },
  };
  const app = createApp();
  const get = (url, signedIn = true) => app.fetch(new Request(origin + url, {
    headers: signedIn ? { Cookie:'__Host-homes-session=' + raw } : {},
  }), env);
  const put = (document, requestOrigin = origin) => app.fetch(new Request(origin + '/api/books', {
    method:'PUT', body:JSON.stringify(document),
    headers:{ Cookie:'__Host-homes-session=' + raw, Origin:requestOrigin, 'Content-Type':'application/json' },
  }), env);

  const doc = {revision:0, books:[book], categories:[], locations:[]};
  const response = await put({...doc, coverChange:{id:book.id, jpeg}});
  assert.equal(response.status, 200);
  const saved = await response.json();
  const token = saved.books[0].photoId;
  assert.match(token, /^[a-f0-9-]{36}$/);
  assert.equal(Object.hasOwn(saved, 'coverChange'), false);

  const path = '/api/books/photo?id=' + token;
  assert.equal((await get(path, false)).status, 401);
  assert.equal((await get(path + '&id=' + token)).status, 400);
  const photo = await get(path);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(photo.headers.get('Cache-Control'), 'no-store');
  assert.equal(photo.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.deepEqual([...new Uint8Array(await photo.arrayBuffer()).slice(0,2)], [255,216]);
  assert.equal((await put({...saved, coverChange:{id:book.id, jpeg:null}}, 'https://other.example')).status, 403);
  assert.equal((await put({...doc, coverChange:{id:book.id, jpeg:null}})).status, 409);
  assert.equal((await put({...saved, coverChange:{id:book.id, jpeg:'PHN2Zz4='}})).status, 400);
  assert.equal((await get(path)).status, 200);

  const kept = await (await put({...saved, books:[{...book, photoId:'attacker-picked'}]})).json();
  assert.equal(kept.books[0].photoId, token);
  const removed = await (await put({...kept, coverChange:{id:book.id, jpeg:null}})).json();
  assert.equal(removed.books[0].photoId, undefined);
  assert.equal((await get(path)).status, 404);

  const restored = await (await put({...removed, coverChange:{id:book.id, jpeg}})).json();
  const restoredPath = '/api/books/photo?id=' + restored.books[0].photoId;
  assert.notEqual(restored.books[0].photoId, token);
  assert.equal((await get(restoredPath)).status, 200);
  assert.equal((await put({...restored, books:[]})).status, 200);
  assert.equal((await get(restoredPath)).status, 404);
});
