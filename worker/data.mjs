const TITLE_LIMIT = 120;
const NOTE_LIMIT = 12_000;
const MAX_BYTES = 80_000;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const HOUSEHOLD_STORE_NAME = 'homes-data-v1:household';
const routePattern = new RegExp(`^/api/(todos|notes)(?:/(${UUID_PATTERN}))?$`);
const versionOK = v => Number.isSafeInteger(v) && v > 0;
const dateOK = v => {
  if (v === null) return true;
  if (typeof v !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) || v.startsWith('0000-')) return false;
  const t = new Date(v);
  return Number.isFinite(t.getTime()) && t.toISOString().slice(0, 10) === v;
};
const jsonBodyType = /^application\/json\s*(?:;\s*charset\s*=\s*(?:"utf-8"|utf-8)\s*)?$/i;

export function validateFields(kind, method, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (method === 'DELETE') return Object.keys(value).length === 1 && versionOK(value.version) ? {version: value.version} : null;
  const editable = kind === 'todos' ? ['title', 'dueDate', ...(method === 'PATCH' ? ['completed'] : [])] : ['title', 'body'];
  const allowed = method === 'PATCH' ? [...editable, 'version'] : editable;
  const fields = Object.keys(value);
  if (fields.some(k => !allowed.includes(k))) return null;
  if (method === 'PATCH' && (!versionOK(value.version) || !fields.some(k => editable.includes(k)))) return null;
  if (method === 'POST' && (!fields.includes('title') || (kind === 'notes' && !fields.includes('body')))) return null;
  if (fields.includes('title') && (typeof value.title !== 'string' || !value.title.trim() || value.title.length > TITLE_LIMIT)) return null;
  if (fields.includes('body') && (typeof value.body !== 'string' || value.body.length > NOTE_LIMIT)) return null;
  if (fields.includes('dueDate') && !dateOK(value.dueDate)) return null;
  if (fields.includes('completed') && typeof value.completed !== 'boolean') return null;
  return Object.fromEntries(fields.map(k => [k, k === 'title' ? value[k].trim() : value[k]]));
}

async function readBoundedJson(request) {
  if (!jsonBodyType.test(request.headers.get('Content-Type') || '')) return [415, 'unsupported_media_type'];
  const length = request.headers.get('Content-Length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_BYTES) return [413, 'payload_too_large'];
  const reader = request.body?.getReader();
  if (!reader) return [400, 'invalid_input'];
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let size = 0, decoded = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
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
  const {pathname, search, origin} = new URL(request.url);
  const {method} = request;
  if (search) return error(400, 'invalid_input');
  const list = pathname === '/api/home';
  const match = pathname.match(routePattern);
  if (!list && !match) return error(404, 'not_found');
  const [, kind, id] = match || [];
  if (!(list ? method === 'GET' : id ? method === 'PATCH' || method === 'DELETE' : method === 'POST')) {
    return error(405, 'method_not_allowed');
  }
  const requestOrigin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if ((requestOrigin !== null && requestOrigin !== origin) ||
      (fetchSite !== null && !['same-origin', 'none'].includes(fetchSite)) ||
      (!list && requestOrigin !== origin)) return error(403, 'forbidden');
  try {
    // This deployment has a single household. Only authenticated members reach this
    // fixed, server-only namespace; neither client nor environment can select a different store.
    const store = env.HOME_STORE.get(env.HOME_STORE.idFromName(HOUSEHOLD_STORE_NAME));
    if (list) return json(200, await store.list());
    const [status, value] = await readBoundedJson(request);
    if (status !== 200) return error(status,value);
    const input = validateFields(kind, method, value);
    if (!input) return error(400,'invalid_input');
    const result = await store.mutate(kind, method, id ?? null, input, kind === 'todos' ? member.alias : null);
    if (result.error === 'version_conflict') return error(409, result.error);
    if (result.error === 'quota_exceeded') return error(409, result.error);
    if (result.error === 'not_found') return error(404, result.error);
    return method === 'DELETE' ? respond(204) : json(method === 'POST' ? 201 : 200, result.record);
  } catch {
    return error(503, 'unavailable');
  }
}
