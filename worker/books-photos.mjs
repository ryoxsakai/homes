import { failure } from './state.mjs';

export const MAX_PHOTO_BYTES = 300_000;
export const MAX_PHOTO_BASE64 = 4 * Math.ceil(MAX_PHOTO_BYTES / 3);
export const PHOTO_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalid = () => failure(400, '表紙写真をJPEGに変換できませんでした。別の写真をお試しください');

// Accept only the small baseline/progressive JPEG emitted by the photo editor.
// The editor redraws onto a canvas to strip original EXIF and other metadata.
// Sanitize application and comment segments that could retain metadata.
function sanitizedJpeg(bytes) {
  const end = bytes.length;
  if (end < 24 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[end - 2] !== 255 || bytes[end - 1] !== 217) return false;
  let i = 2, frame = false, scans = 0, inScan = false;
  const remove = [];
  while (i < end) {
    if (inScan) {
      while (i < end && bytes[i] !== 255) i++;
      if (i >= end - 1) return false;
    }
    const start = i;
    if (bytes[i++] !== 255) return false;
    while (i < end && bytes[i] === 255) i++;
    const marker = bytes[i++];
    if (inScan && (marker === 0 || (marker >= 208 && marker <= 215))) continue;
    inScan = false;
    if (marker === 217) {
      if (i !== end || !frame || !scans) return false;
      const result = new Uint8Array(end - remove.reduce((count, [a, b]) => count + b - a, 0));
      let from = 0, into = 0;
      for (const [a, b] of remove) {
        result.set(bytes.subarray(from, a), into);
        into += a - from;
        from = b;
      }
      result.set(bytes.subarray(from), into);
      return result.buffer;
    }
    const imageMarker = [192, 193, 194, 196, 219, 221, 218].includes(marker);
    const metadata = marker >= 224 && marker <= 239 || marker === 254;
    if (!imageMarker && !metadata) return false;
    if (i + 1 >= end) return false;
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2 || i + length > end - 2) return false;
    if (metadata && !(marker === 224 && length === 16 &&
        new TextDecoder().decode(bytes.subarray(i + 2, i + 7)) === 'JFIF\0' && !bytes[i + 14] && !bytes[i + 15])) {
      remove.push([start, i + length]);
    }
    if ([192, 193, 194].includes(marker)) {
      if (frame || length < 11 || bytes[i + 2] !== 8) return false;
      const width = (bytes[i + 5] << 8) | bytes[i + 6];
      const height = (bytes[i + 3] << 8) | bytes[i + 4];
      if (!width || !height || width > 1000 || height > 1000) return false;
      frame = true;
    }
    if (marker === 218) {
      if (!frame || length < 6) return false;
      scans++;
      inScan = true;
    }
    i += length;
  }
  return false;
}

// A single cover write/remove is applied with the revision-checked book save.
export function readCoverChange(change, books) {
  if (change === undefined) return null;
  if (!change || typeof change !== 'object' || Array.isArray(change) ||
      typeof change.id !== 'string' || !books.some(book => book.id === change.id)) throw invalid();
  if (change.jpeg === null) return { id: change.id, bytes: null };
  if (typeof change.jpeg !== 'string') throw invalid();
  if (change.jpeg.length > MAX_PHOTO_BASE64) throw failure(413, '表紙写真が大きすぎます');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(change.jpeg) || change.jpeg.length % 4) throw invalid();
  let raw;
  try { raw = atob(change.jpeg); } catch { throw invalid(); }
  const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw failure(413, '表紙写真が大きすぎます');
  const jpeg = sanitizedJpeg(bytes);
  if (!jpeg) throw invalid();
  return { id: change.id, bytes: jpeg };
}
