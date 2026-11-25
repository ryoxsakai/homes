import { MAX_DOCUMENT_BYTES } from './state.mjs';
import { fetchCover, lookupBook } from './books.mjs';
import { MAX_PHOTO_BASE64, PHOTO_ID } from './books-photos.mjs';

const HOUSEHOLD_STORE_NAME = 'homes-data-v1:household';
const CLONE_REQUEST = /^[a-zA-Z0-9_-]{16,100}$/;
const jsonBodyType = /^application\/json\s*(?:;\s*charset\s*=\s*(?:"utf-8"|utf-8)\s*)?$/i;

// Same-origin JSON API for the Works-based ToDo and Memo screens:
//   GET /api/me
//   GET|PUT /api/todo, GET /api/todo/clone?request_id=…, POST /api/todo/clone
//   GET|PUT /api/memo
//   GET|PUT /api/books, GET /api/books/lookup?isbn=…, GET /api/books/cover?id=…
const routes = {
  '/api/me': ['GET'],
  '/api/todo': ['GET', 'PUT'],
  '/api/todo/clone': ['GET', 'POST'],
  '/api/memo': ['GET', 'PUT'],
  '/api/books': ['GET', 'PUT'],
  '/api/books/lookup': ['GET'],
  '/api/books/cover': ['GET'],
  '/api/books/photo': ['GET'],
};
// The only GET requests that take a query string, each with exactly one parameter.
const queries = {
  '/api/todo/clone': ['request_id', v => CLONE_REQUEST.test(v)],
  '/api/books/lookup': ['isbn', v => /^[0-9Xx -]{10,17}$/.test(v)],
  '/api/books/cover': ['id', v => /^[A-Za-z0-9_-]{4,40}$/.test(v)],
  '/api/books/photo': ['id', v => PHOTO_ID.test(v)],
};

export async function readBoundedJson(request, limit = MAX_DOCUMENT_BYTES) {
  if (!jsonBodyType.test(request.headers.get('Content-Type') || '')) return [415, 'unsupported_media_type'];
  const length = request.headers.get('Content-Length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > limit) return [413, 'payload_too_large'];
  const reader = request.body?.getReader();
  if (!reader) return [400, 'invalid_input'];
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let size = 0, decoded = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        // The promise may not settle until the producer stops; no need to await it.
        void reader.cancel().catch(() => {});
        return [413, 'payload_too_large'];
      }
      decoded += decoder.decode(value, {stream:true});
    }
    decoded += decoder.decode();
    return [200, JSON.parse(decoded)];
  } catch {
    return [400, 'invalid_input'];
  } finally {
    reader.releaseLock();
  }
}

export async function handleHomesData(request, env, member, respond) {
  const json = (status, val) => respond(status, JSON.stringify(val), {type:'application/json; charset=utf-8'});
  const error = (status, code) => json(status, {error:code});
  if (!member) return error(401, 'unauthorized');
  if (!env.HOME_STORE) return error(503, 'unavailable');
  const url = new URL(request.url);
  const {pathname, origin, searchParams} = url;
  const {method} = request;
  const allowed = routes[pathname];
  if (!allowed) return error(404, 'not_found');
  if (!allowed.includes(method)) return error(405, 'method_not_allowed');
  const cloneLookup = pathname === '/api/todo/clone' && method === 'GET';
  const query = method === 'GET' && queries[pathname];
  if (query
    ? [...searchParams.keys()].join() !== query[0] || !query[1](searchParams.get(query[0]))
    : url.search) return error(400, 'invalid_input');
  const requestOrigin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if ((requestOrigin !== null && requestOrigin !== origin) ||
      (fetchSite !== null && !['same-origin', 'none'].includes(fetchSite)) ||
      (method !== 'GET' && requestOrigin !== origin)) return error(403, 'forbidden');
  if (pathname === '/api/me') return json(200, {name: member.alias});
  if (pathname === '/api/books/cover') {
    const cover = await fetchCover(searchParams.get('id'));
    return cover ? respond(200, cover.body, {type: cover.type, cache: 'private, max-age=604800'}) : respond(404, null, {type: 'text/plain; charset=utf-8'});
  }
  if (pathname === '/api/books/lookup') {
    const found = await lookupBook(searchParams.get('isbn'), env);
    return found.error ? json(found.error.status, {error: found.error.message,
      ...(found.ndlStatus && { ndlStatus: found.ndlStatus })}) : json(200, found.value);
  }
  try {
    // This deployment has a single household. Only authenticated members reach this
    // fixed, server-only namespace; neither client nor environment can select a different store.
    const store = env.HOME_STORE.get(env.HOME_STORE.idFromName(HOUSEHOLD_STORE_NAME));
    if (pathname === '/api/books/photo') {
      const jpeg = await store.bookCoverPhoto(searchParams.get('id'));
      return jpeg ? respond(200, jpeg, {type:'image/jpeg', cache:'no-store'})
        : respond(404, null, {type:'text/plain; charset=utf-8'});
    }
    let result;
    if (method === 'GET') {
      result = cloneLookup ? await store.cloneResult(searchParams.get('request_id'))
        : await store.read(pathname.slice('/api/'.length));
      if (pathname === '/api/todo' && result.value) result.value.plannerVersion = 1;
    } else {
      const [status, body] = await readBoundedJson(request, pathname === '/api/books' ? MAX_DOCUMENT_BYTES + MAX_PHOTO_BASE64 + 512 : MAX_DOCUMENT_BYTES);
      if (status !== 200) return error(status, body);
      result = pathname === '/api/memo' ? await store.putMemo(body)
        : pathname === '/api/books' ? await store.putBooks(body, member.alias)
        : pathname === '/api/todo' ? await store.putTodo(body, member.alias)
        : await store.cloneTodo(body, member.alias);
    }
    if (result.error) return json([400, 404, 409, 413].includes(result.error.status) ? result.error.status : 400, {error: result.error.message});
    return json(200, result.value);
  } catch {
    return error(503, 'unavailable');
  }
}
