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

// Keep new-book fields separate from list filters and distinguish an explicitly
// cleared selection from a browser that has never saved a preference.
const ENTRY_KEY = 'homes-books-new-entry';
const fieldNames = ['location', 'category'];
function entryPreferences(value) {
  return Object.fromEntries(fieldNames.flatMap(field => {
    const selection = value?.[field];
    return typeof selection === 'string' && selection.length <= 50 ? [[field, selection]] : [];
  }));
}

export function readBookEntryPreferences(storage) {
  try { return entryPreferences(JSON.parse(storage?.getItem(ENTRY_KEY) || '{}')); }
  catch { return {}; }
}
export function writeBookEntryPreferences(storage, preferences) {
  try { storage?.setItem(ENTRY_KEY, JSON.stringify(entryPreferences(preferences))); }
  catch { /* Continue using the current in-memory preferences. */ }
}
export function resolveBookEntryPreferences(preferences, shelf) {
  return {
    location: shelf.locations.includes(preferences.location) ? preferences.location : '',
    category: preferences.category === undefined && shelf.categories.includes('絵本') ? '絵本'
      : shelf.categories.includes(preferences.category) ? preferences.category : '',
  };
}
