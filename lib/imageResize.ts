/**
 * Browser-side image shrinking for launches: any image data URL → at most 256×256, WebP when the
 * browser can encode it (Safari cannot: PNG fallback, then JPEG), and never over LIMITS.imageBytes.
 * Re-encoding also strips metadata (EXIF / GPS) from uploads.
 */
import { LIMITS } from './shared/api';

/** Decoded size of a base64 data URL, computed the same way the server validates it. */
export const dataUrlBytes = (u: string) => {
  const i = u.indexOf(',');
  return i < 0 ? 0 : Math.floor((u.length - i - 1) * 0.75);
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be read.'));
    img.src = src;
  });
}

export async function downscaleImage(src: string, opts: { maxSide?: number; maxBytes?: number } = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? LIMITS.imageBytes;
  const img = await loadImage(src);
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error('That image is empty.');
  let side = opts.maxSide ?? 256;
  for (let round = 0; round < 5; round++) {
    const scale = Math.min(1, side / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot resize images.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    for (const q of [0.9, 0.8, 0.65]) {
      const webp = canvas.toDataURL('image/webp', q);
      if (!webp.startsWith('data:image/webp')) break; // no WebP encoder: fall back below
      if (dataUrlBytes(webp) <= maxBytes) return webp;
    }
    const png = canvas.toDataURL('image/png');
    if (dataUrlBytes(png) <= maxBytes) return png;
    const jpg = canvas.toDataURL('image/jpeg', 0.82);
    if (jpg.startsWith('data:image/jpeg') && dataUrlBytes(jpg) <= maxBytes) return jpg;
    side = Math.max(32, Math.round(side * 0.7));
  }
  throw new Error('Could not make the image small enough. Try another one.');
}
