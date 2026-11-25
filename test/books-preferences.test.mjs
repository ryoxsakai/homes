import test from 'node:test';
import assert from 'node:assert/strict';
import { readBooksPreferences, writeBooksPreferences } from '../public/books/preferences.mjs';

test('uses the current bookshelf settings key and migrates the old view and sort', () => {
  const storage = { getItem(key) {
    assert.equal(key, 'homes-books-view');
    return '{"view":"list","sort":"title"}';
  } };
  assert.deepEqual(readBooksPreferences(storage), {
    status: 'all', query: '', category: '', location: '', tag: '',
    sort: 'title', view: 'list', filtersOpen: false,
  });
});

test('remembers the complete local bookshelf display and filters on the next load', () => {
  const map = new Map();
  const storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
  const expected = {
    status: 'wanted', query: 'りんご', category: '絵本', location: '本棚', tag: 'お気に入り',
    sort: 'author', view: 'grid', filtersOpen: true,
  };
  writeBooksPreferences(storage, { ...expected, bookData: ['ignored'] });
  assert.deepEqual(readBooksPreferences(storage), expected);
  writeBooksPreferences(storage, { ...expected, filtersOpen: false });
  assert.deepEqual(readBooksPreferences(storage), { ...expected, filtersOpen: false });
});

test('bad or unavailable local storage is safe and defaults to a collapsed list toolbar', () => {
  assert.deepEqual(readBooksPreferences({ getItem: () => '{' }), readBooksPreferences(null));
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => writeBooksPreferences(denied, {}));
  assert.deepEqual(readBooksPreferences(denied), readBooksPreferences(null));
  const corrupted = readBooksPreferences({ getItem: () => '{"status":"weird","view":"broken","query":123,"sort":"bad","filtersOpen":"yes"}' });
  assert.deepEqual(corrupted, readBooksPreferences(null));
});
