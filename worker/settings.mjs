// Admin-only settings API: the family member list and display names.
//   GET    /api/settings/members           list
//   POST   /api/settings/members {email, alias, sub?}   add a member
//   PUT    /api/settings/members {email, alias}         change a display name
//   DELETE /api/settings/members {email}                remove an added member
// Members defined in the Worker secret stay; only their display names can change here.
import { MAX_MEMBERS, MEMBER_LABEL, MEMBER_SUB, normalEmail } from './members.mjs';

const view = m => ({ email: m.email, alias: m.alias, source: m.source, admin: !!m.admin, hasSub: m.sub !== null && m.sub !== undefined });

function checkAlias(raw, members, except) {
  const alias = typeof raw === 'string' ? raw.trim().normalize('NFC') : '';
  if (!alias || !MEMBER_LABEL.test(alias) || alias.includes('@')) return [null, '表示名は1〜40文字で、@を含めないでください'];
  if ([...members.values()].some(m => m.email !== except && m.alias === alias)) return [null, 'その表示名はほかの人が使っています'];
  return [alias];
}

// Moves past records from old to new names, oldest rename first. A task is removed
// only after its rewrite succeeds, so a failure is retried on the next settings call.
async function applyPendingRenames(auth, env) {
  const store = env.HOME_STORE?.get(env.HOME_STORE.idFromName('homes-data-v1:household'));
  if (!store) return;
  for (const task of await auth.pendingRenames()) {
    await store.renameActor(task.from_alias, task.to_alias);
    await auth.finishRename(task.id);
  }
}

export async function handleSettings({ method, body, member, members, env, json }) {
  if (!member.admin) return json(403, { error: '設定は管理者だけが使えます' });
  const auth = env.AUTH_STORE.get(env.AUTH_STORE.idFromName('homes-auth-v1'));
  // The secret's members, with their original names, for the store's uniqueness check.
  const base = [...members.values()].filter(m => m.source === 'secret').map(m => ({ email: m.email, alias: m.baseAlias ?? m.alias }));
  try { await applyPendingRenames(auth, env); } catch { /* Kept; retried on the next call. */ }
  const list = () => json(200, { members: [...members.values()].map(view), max: MAX_MEMBERS });
  if (method === 'GET') return list();
  const email = normalEmail(body?.email);
  if (!email) return json(400, { error: 'メールアドレスを確認してください' });
  const target = members.get(email);

  if (method === 'POST') {
    if (target) return json(409, { error: 'このメールアドレスはすでに登録されています' });
    if (members.size >= MAX_MEMBERS) return json(400, { error: `メンバーは${MAX_MEMBERS}人までです` });
    const [alias, problem] = checkAlias(body.alias, members);
    if (!alias) return json(400, { error: problem });
    const sub = typeof body.sub === 'string' && body.sub.trim() ? body.sub.trim() : null;
    if (sub !== null && !MEMBER_SUB.test(sub)) return json(400, { error: 'GoogleアカウントIDの形式が正しくありません' });
    if (sub === null && !email.endsWith('@gmail.com')) return json(400, { error: 'Gmail以外のアドレスはGoogleアカウントIDも入力してください' });
    if (sub !== null && [...members.values()].some(m => m.sub === sub)) return json(409, { error: 'このGoogleアカウントIDはすでに登録されています' });
    const saved = await auth.addMember(email, alias, sub, base);
    if (saved?.error) return json(saved.status, { error: saved.error });
    members.set(email, { email, alias, sub, source: 'added', admin: false });
    return list();
  }
  if (!target) return json(404, { error: 'メンバーが見つかりません' });

  if (method === 'PUT') {
    const [alias, problem] = checkAlias(body.alias, members, email);
    if (!alias) return json(400, { error: problem });
    if (alias !== target.alias) {
      const saved = await auth.setMemberName(email, alias, base);
      if (saved?.error) return json(saved.status, { error: saved.error });
      target.alias = alias;
      // Records already show the old name; move them now (retried later if this fails).
      try { await applyPendingRenames(auth, env); }
      catch { return json(503, { error: '表示名は変更しました。過去の記録の名前は次に設定を開いたときに更新します' }); }
    }
    return list();
  }
  if (method === 'DELETE') {
    if (target.admin || email === member.email) return json(400, { error: '管理者は削除できません' });
    if (target.source !== 'added') return json(400, { error: 'このメンバーはCloudflareのシークレットで設定されているため、ここでは削除できません' });
    await auth.removeMember(email);
    members.delete(email);
    return list();
  }
  return json(405, { error: 'method_not_allowed' });
}
