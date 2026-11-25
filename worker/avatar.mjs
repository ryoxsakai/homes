const avatarOrigin = 'https://lh3.googleusercontent.com';
const maxBytes = 96 * 1024;
const imagePath = /^\/(a|a-)\/([A-Za-z0-9_-]{1,512})(?:=s[0-9]{1,4}(?:-c)?)?$/;

// Accept only the two Google profile image path families. Replace provider sizing
// rather than relaying arbitrary path parameters or any user-supplied URL.
export function trustedPicture(value) {
  if (typeof value !== 'string' || !value.startsWith(avatarOrigin + '/')) return null;
  const match = imagePath.exec(value.slice(avatarOrigin.length));
  if (!match || match[0] !== value.slice(avatarOrigin.length)) return null;
  return `${avatarOrigin}/${match[1]}/${match[2]}=s96-c`;
}

const starts = (bytes, prefix, offset = 0) => prefix.every((byte, i) => bytes[offset + i] === byte);
const headers = {
  'image/jpeg': bytes => starts(bytes, [255, 216, 255]),
  'image/png': bytes => starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10]),
  'image/webp': bytes => starts(bytes, [82, 73, 70, 70]) && starts(bytes, [87, 69, 66, 80], 8)
};

export async function avatarResponse(picture, upstream, response) {
  const target = trustedPicture(picture);
  if (!target) return response(404);
  try {
    const result = await upstream(target, {
      redirect: 'manual', signal: AbortSignal.timeout(4000),
      headers: { Accept: 'image/jpeg, image/png, image/webp' }
    });
    const type = result.headers.get('Content-Type')?.trim().toLowerCase();
    const size = result.headers.get('Content-Length');
    if (result.status !== 200 || !Object.hasOwn(headers, type)
        || (size !== null && (!/^\d{1,6}$/.test(size) || Number(size) > maxBytes))
        || !result.body) {
      if (result.body) void result.body.cancel().catch(() => {});
      return response(404);
    }
    const reader = result.body.getReader(), buffer = new Uint8Array(maxBytes);
    let offset = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > maxBytes) {
          void reader.cancel().catch(() => {});
          return response(404);
        }
        buffer.set(value, offset);
        offset += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = buffer.subarray(0, offset);
    return headers[type](bytes) ? response(200, bytes, { type }) : response(404);
  } catch {
    return response(404);
  }
}
