// Camera barcode reader for ISBN (EAN-13). Uses the browser's BarcodeDetector where it
// supports EAN-13 (Chrome on Android); elsewhere, including iPhone Safari, the
// self-hosted ZXing library decodes frames. Nothing leaves the device.
import { isIsbn13 } from './isbn.mjs';

const ZXING_SRC = '/books/vendor/zxing-library-0.21.3.min.js';
let zxingLoad;

function loadZxing() {
  zxingLoad ??= new Promise((resolve, reject) => {
    if (window.ZXing) return resolve(window.ZXing);
    const script = document.createElement('script');
    script.src = ZXING_SRC;
    script.onload = () => window.ZXing ? resolve(window.ZXing) : reject(Error('ZXing unavailable'));
    script.onerror = () => { zxingLoad = null; reject(Error('ZXing unavailable')); };
    document.head.append(script);
  });
  return zxingLoad;
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return formats.includes('ean_13') ? new window.BarcodeDetector({ formats: ['ean_13'] }) : null;
  } catch { return null; }
}

async function zxingDecoder() {
  const ZXing = await loadZxing();
  const hints = new Map([
    [ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]],
    [ZXing.DecodeHintType.TRY_HARDER, true],
  ]);
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
  return canvas => {
    try {
      const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas)));
      return reader.decodeWithState(bitmap).getText();
    } catch {
      return null; // No barcode in this frame.
    } finally {
      reader.reset();
    }
  };
}

export function cameraAvailable() {
  return !!navigator.mediaDevices?.getUserMedia;
}

// Starts the camera in `video` and calls onIsbn(isbn) once for the first ISBN read.
// onOther() is called (throttled) when a non-ISBN EAN-13 such as the price code is seen.
// Resolves to a stop() function; rejects with a user-facing message.
export async function startScanner(video, { onIsbn, onOther }) {
  if (!cameraAvailable()) throw Error('この端末ではカメラを使えません。ISBNを入力してください');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (error) {
    throw Error(error?.name === 'NotAllowedError'
      ? 'カメラの使用が許可されていません。ブラウザーの設定で許可するか、ISBNを入力してください'
      : 'カメラを起動できませんでした。ISBNを入力してください');
  }
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
  try {
    await video.play();
  } catch {
    stop();
    throw Error('カメラの映像を表示できませんでした');
  }

  const detector = await nativeDetector();
  let decode;
  if (!detector) {
    try { decode = await zxingDecoder(); } catch {
      stop();
      throw Error('読み取り機能を読み込めませんでした。ISBNを入力してください');
    }
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let lastOther = 0;

  const found = text => {
    if (stopped || !text) return false;
    if (isIsbn13(text)) {
      stop();
      navigator.vibrate?.(60);
      onIsbn(text);
      return true;
    }
    if (Date.now() - lastOther > 2500) { lastOther = Date.now(); onOther?.(text); }
    return false;
  };

  const tick = async () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes.some(code => found(code.rawValue))) return;
        } else {
          // Decode the middle band, where the on-screen guide asks for the barcode.
          const w = video.videoWidth, h = video.videoHeight;
          const bandH = Math.round(h * 0.5), scale = Math.min(1, 960 / w);
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(bandH * scale);
          context.drawImage(video, 0, (h - bandH) / 2, w, bandH, 0, 0, canvas.width, canvas.height);
          if (found(decode(canvas))) return;
        }
      } catch { /* Keep scanning; a single frame can fail. */ }
    }
    setTimeout(tick, detector ? 120 : 180);
  };
  tick();
  return stop;
}
