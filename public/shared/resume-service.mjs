export const servicePaths = ['/todo/', '/memo/'];
const key = 'homes_last_service';

export function lastService() {
  try {
    const saved = localStorage.getItem(key);
    if (servicePaths.includes(saved)) return saved;
  } catch {}
  return '/todo/';
}

export function rememberService(path) {
  if (!servicePaths.includes(path)) return;
  try { localStorage.setItem(key, path); } catch {}
}
