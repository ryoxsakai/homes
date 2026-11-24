// Set ONLY after the distinct Homes login endpoint has passed deployment checks.
const homesOrigin = '';
if (homesOrigin) {
  const entry = new URL(homesOrigin);
  if (entry.protocol === 'https:' && entry.origin === homesOrigin) {
    const link = document.querySelector('#homes-sign-in');
    link.href = entry.href;
    link.hidden = false;
  }
}
