export function readGrocery(data) {
  const { toBuy, purchased, categories } = data;
  const orders = [...toBuy, ...purchased].map(item => item.id);
  const ids = new Set(orders);
  return { toBuy, purchased, categories, itemOrder: [...new Set([
    ...(Array.isArray(data.itemOrder) ? data.itemOrder.filter(id => ids.has(id)) : []), ...orders,
  ])] };
}

export function groceryItems(state) {
  const entries = new Map();
  for (const [bucket, items] of [['toBuy', state.toBuy], ['purchased', state.purchased]]) {
    for (const item of items) entries.set(item.id, { item, bucket,
      inStock: item.inStock ?? bucket === 'purchased',
      buyChecked: item.buyChecked ?? bucket === 'toBuy',
      expiryEnabled: item.expiryEnabled ?? Boolean(item.expiryDate),
      expiryKind: item.expiryKind ?? 'best-before',
    });
  }
  return state.itemOrder.map(id => entries.get(id)).filter(Boolean);
}

// Swap two displayed siblings without disturbing positions of hidden categories.
export function moveItem(order, visible, id, direction) {
  if (direction !== -1 && direction !== 1) return null;
  const i = visible.indexOf(id);
  const other = i >= 0 ? visible[i + direction] : undefined;
  if (other === undefined) return null;
  const next = [...order], a = next.indexOf(id), b = next.indexOf(other);
  if (a < 0 || b < 0) return null;
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

// Commit once on release after a deliberate right swipe, whether or not it was moved back by hand.
export const SWIPE_ARM = 40;
export function swipeStep(state, dx, dy) {
  if (state.cancelled) return state;
  if (!state.horizontal && Math.max(Math.abs(dx), Math.abs(dy)) >= 9) {
    if (dx < 0 || Math.abs(dy) >= dx * .78) return { ...state, cancelled: true };
    state = { ...state, horizontal: true };
  }
  if (!state.horizontal) return state;
  if (Math.abs(dy) > 45 || dx < -24) return { ...state, cancelled: true, offset: 0 };
  const armed = state.armed || dx >= SWIPE_ARM;
  return { ...state, armed, offset: Math.min(64, Math.max(0, dx)) };
}
export const shouldToggleBuy = swipe => Boolean(swipe.horizontal && swipe.armed && !swipe.cancelled);
