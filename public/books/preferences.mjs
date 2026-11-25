// Browser-only preferences; no shelf data or settings are sent to the server.
const KEY = 'homes-books-view';
const sorts = ['added-desc', 'added-asc', 'title', 'author', 'published-desc', 'published-asc', 'location', 'category'];
const string = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

function normal(saved) {
  const value = saved && typeof saved === 'object' ? saved : {};
  return {
    status: ['all', 'borrowed', 'owned', 'wanted'].includes(value.status) ? value.status : 'all',
    query: string(value.query, 300),
    category: string(value.category, 100),
    location: string(value.location, 100),
    tag: string(value.tag, 100),
    sort: sorts.includes(value.sort) ? value.sort : 'added-desc',
    view: ['grid', 'list'].includes(value.view) ? value.view : 'grid',
    filtersOpen: value.filtersOpen === true,
  };
}

export function readBooksPreferences(storage) {
  try { return normal(JSON.parse(storage?.getItem(KEY) || '{}')); }
  catch { return normal(); }
}

export function writeBooksPreferences(storage, preferences) {
  try { storage?.setItem(KEY, JSON.stringify(normal(preferences))); }
  catch { /* Storage is optional; the current view can still be used. */ }
}
