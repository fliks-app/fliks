const SIZE = 16;

/** A dark tint of the image's dominant hue, or null for a grey or unreadable image. */
export async function coverTint(url: string): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, SIZE, SIZE);
    bmp.close();
    return tintOf(ctx.getImageData(0, 0, SIZE, SIZE).data);
  } catch {
    return null;
  }
}

/** Buckets RGBA pixels by hue, weighted by chroma so vivid pixels win over greys. */
export function tintOf(px: Uint8ClampedArray): string | null {
  const bins = Array.from({ length: 12 }, () => ({ w: 0, x: 0, y: 0, s: 0 }));
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
    if (c < 0.08) continue;
    const h = (max === r ? ((g - b) / c + 6) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60;
    const bin = bins[Math.floor(h / 30) % 12];
    bin.w += c;
    bin.x += Math.cos((h * Math.PI) / 180) * c;
    bin.y += Math.sin((h * Math.PI) / 180) * c;
    bin.s += (c / (1 - Math.abs(max + min - 1))) * c;
    total += c;
  }
  const top = bins.reduce((a, b) => (b.w > a.w ? b : a));
  if (total < (px.length / 4) * 0.05) return null;
  const hue = Math.round(((Math.atan2(top.y, top.x) * 180) / Math.PI + 360) % 360);
  return `hsl(${hue} ${Math.round(Math.min(0.6, top.s / top.w) * 100)}% 26%)`;
}
