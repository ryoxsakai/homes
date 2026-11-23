const EMAIL = /^[^\s@]+@[^\s@]+$/;
const SUB = /^[\x21-\x7e]{1,255}$/;
const LABEL = /^[^\p{C}]{1,40}$/u;

function normalEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export function readMembers(env) {
  if (env.HOMES_FAMILY_MEMBERS === undefined) {
    const email = normalEmail(env.HOMES_OWNER_EMAIL);
    const sub = env.HOMES_OWNER_SUB || null;
    if (!email || (sub !== null && (typeof sub !== 'string' || !SUB.test(sub)))) return null;
    return new Map([[email, {sub, alias:'管理者'}]]);
  }
  // Family mode replaces, never augments or falls back to, legacy owner privileges.
  try {
    const raw = env.HOMES_FAMILY_MEMBERS;
    if (typeof raw !== 'string' || raw.length > 12_000) return null;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 32) return null;
    const map = new Map(), aliases = new Set(), subjects = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || Object.keys(entry).some(k => !['email','alias','sub'].includes(k))) return null;
      const email = normalEmail(entry.email);
      const alias = typeof entry.alias === 'string' ? entry.alias.trim().normalize('NFC') : null;
      const sub = entry.sub === undefined ? null : entry.sub;
      if (!email || !alias || !LABEL.test(alias) || alias.includes('@') || map.has(email) || aliases.has(alias)
          || (entry.sub === undefined ? !email.endsWith('@gmail.com') : typeof sub !== 'string' || !SUB.test(sub) || subjects.has(sub))) return null;
      map.set(email, {alias, sub});
      aliases.add(alias);
      if (sub !== null) subjects.add(sub);
    }
    return map;
  } catch { return null; }
}

export function authorizedMember(session, members) {
  if (!session || typeof session.sub !== 'string' || !SUB.test(session.sub)) return null;
  const email = normalEmail(session.email);
  const member = members.get(email);
  return member && (member.sub === null ? email.endsWith('@gmail.com') : member.sub === session.sub) ? member : null;
}
