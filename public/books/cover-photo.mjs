const MAX_INPUT = 30_000_000;
const MAX_PHOTO = 300_000;

function imageFromFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('写真を開けませんでした。JPEG・PNGの写真をお試しください')); };
    image.src = url;
  });
}

export async function prepareCoverPhoto(file) {
  if (!file?.size || file.size > MAX_INPUT) throw new Error('30MB以下の写真を選んでください');
  const image = await imageFromFile(file);
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60_000_000)
    throw new Error('写真が大きすぎます。小さい写真を選んでください');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('この端末で写真を変換できませんでした');
  // Redraw only pixels; the original photo and its metadata are never sent.
  for (const [edge, quality] of [[900, 0.84], [900, 0.7], [740, 0.64], [600, 0.59]]) {
    const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataURL = canvas.toDataURL('image/jpeg', quality);
    const jpeg = dataURL.startsWith('data:image/jpeg;base64,') && dataURL.slice('data:image/jpeg;base64,'.length);
    if (jpeg && Math.floor(jpeg.length * 0.75) - (jpeg.endsWith('==') ? 2 : jpeg.endsWith('=') ? 1 : 0) <= MAX_PHOTO)
      return { dataURL, jpeg };
  }
  throw new Error('表紙写真を小さくできませんでした。別の写真をお試しください');
}
