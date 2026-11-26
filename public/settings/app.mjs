// Homes 設定 (administrator only): family members and their display names.
// The server refuses this page and /api/settings/members to everyone but the admin.
import { watchAuth, signOutUser } from '../shared/auth.js?v=14';
import { $, esc, toast } from '../shared/homes-doc.mjs?v=1';

let members = [];
let busy = false;

async function api(method, body) {
  const response = await fetch('/api/settings/members', {
    method, cache: 'no-store', credentials: 'same-origin',
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Error(data?.error || `通信に失敗しました (${response.status})`);
  return data;
}

// One request at a time; the list shown is always the server's answer.
async function run(method, body, message) {
  if (busy) return false;
  busy = true;
  $('#save-status').textContent = '保存中…';
  try {
    ({ members } = await api(method, body));
    render();
    if (message) toast(message);
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  } finally {
    busy = false;
    $('#save-status').textContent = '';
  }
}

function render() {
  $('#member-list').innerHTML = members.map(m => `<li class="homes-row">
    <div class="settings-member">
      <span class="homes-row-title">${esc(m.alias)}${m.admin ? '<span class="settings-badge">管理者</span>' : ''}</span>
      <span class="settings-email">${esc(m.email)}${m.source === 'secret' ? '・Cloudflareのシークレットで設定' : ''}</span>
    </div>
    <span class="settings-actions">
      <button type="button" class="homes-btn homes-btn-quiet" data-rename="${esc(m.email)}">名前を変更</button>
      ${m.source === 'added' && !m.admin ? `<button type="button" class="homes-btn homes-btn-quiet homes-btn-danger" data-remove="${esc(m.email)}">削除</button>` : ''}
    </span>
  </li>`).join('');
}

$('#member-list').addEventListener('click', async event => {
  const rename = event.target.closest('[data-rename]');
  const remove = event.target.closest('[data-remove]');
  const member = members.find(m => m.email === (rename || remove)?.dataset[rename ? 'rename' : 'remove']);
  if (!member) return;
  if (rename) {
    const alias = (prompt(`「${member.alias}」の新しい表示名`, member.alias) || '').trim();
    if (!alias || alias === member.alias) return;
    await run('PUT', { email: member.email, alias }, `表示名を「${alias}」に変更しました`);
  } else if (confirm(`「${member.alias}」（${member.email}）を削除しますか？ この人はすぐにログインできなくなります。`)) {
    await run('DELETE', { email: member.email }, `「${member.alias}」を削除しました`);
  }
});

$('#add-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const email = form.email.value.trim();
  const alias = form.alias.value.trim();
  const sub = form.sub.value.trim();
  if (!email) { toast('メールアドレスを入力してください'); form.email.focus(); return; }
  if (!alias) { toast('表示名を入力してください'); form.alias.focus(); return; }
  if (!sub && !/@gmail\.com$/i.test(email)) {
    $('#sub-details').open = true;
    toast('Gmail以外のアドレスはGoogleアカウントIDも入力してください');
    form.sub.focus();
    return;
  }
  if (await run('POST', { email, alias, ...(sub && { sub }) }, `「${alias}」を追加しました`)) form.reset();
});

$('#sign-out').addEventListener('click', async () => {
  if (!confirm('ログアウトしますか？')) return;
  await signOutUser();
  if (window === top) location.replace('/');
});

watchAuth({
  async onSignedIn() {
    try {
      ({ members } = await api('GET'));
      $('#loading').hidden = true;
      $('#app-main').hidden = false;
      $('#user-bar').hidden = false;
      render();
    } catch (error) {
      $('#loading').textContent = error.message;
    }
    document.body.dataset.serviceReady = 'true';
  },
  onSignedOut(message) {
    if (message) $('#loading').textContent = message;
    document.body.dataset.serviceReady = 'true';
  },
});
