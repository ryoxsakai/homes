// ISBN rules shared by the bookshelf page and the Worker (worker/books.mjs).

// ISBN-13 (978/979) with a valid check digit. Japanese books also carry a second
// "192…" price barcode below the ISBN, which this rejects.
export function isIsbn13(value) {
  if (typeof value !== 'string' || !/^97[89]\d{10}$/.test(value)) return false;
  return checkDigit13(value.slice(0, 12)) === Number(value[12]);
}

function checkDigit13(first12) {
  const sum = [...first12].reduce((total, d, i) => total + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

// Accepts ISBN-13 or ISBN-10 (hyphens and spaces allowed) and returns ISBN-13, or null.
export function normalizeIsbn(input) {
  if (typeof input !== 'string') return null;
  const raw = input.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{13}$/.test(raw)) return isIsbn13(raw) ? raw : null;
  if (!/^\d{9}[\dX]$/.test(raw)) return null;
  const sum10 = [...raw].reduce((t, c, i) => t + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
  if (sum10 % 11) return null;
  const body = '978' + raw.slice(0, 9);
  return body + checkDigit13(body);
}

