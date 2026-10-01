/**
 * Deterministic procedural "paintings" (spec §8.2 fallback): soft colour-field abstracts as SVG,
 * rasterised by sharp. Used for every work with `--offline` and for any work whose download fails;
 * the manifest marks those images `fallback: true`. The same seed always yields the same SVG.
 */

/** mulberry32: a tiny deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

/**
 * An SVG of `width × height` px: a toned ground, a few blurred colour fields and brush-like strokes,
 * in a palette derived from `seed`.
 */
export function proceduralPaintingSvg(
  seed: number,
  width: number,
  height: number,
): string {
  const rnd = prng(seed);
  const baseHue = rnd() * 360;
  const ground = hsl(baseHue, 18 + rnd() * 20, 70 + rnd() * 15);
  const parts: string[] = [];
  const fields = 5 + Math.floor(rnd() * 4);
  for (let i = 0; i < fields; i++) {
    const hue = (baseHue + (rnd() - 0.5) * 120 + 360) % 360;
    const w = width * (0.3 + rnd() * 0.6);
    const h = height * (0.15 + rnd() * 0.4);
    const x = rnd() * (width - w * 0.5) - w * 0.25;
    const y = rnd() * (height - h * 0.5) - h * 0.25;
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(Math.min(w, h) * 0.2).toFixed(1)}" fill="${hsl(hue, 30 + rnd() * 40, 35 + rnd() * 35)}" opacity="${(0.45 + rnd() * 0.4).toFixed(2)}" filter="url(#soft)"/>`,
    );
  }
  const strokes = 12 + Math.floor(rnd() * 12);
  for (let i = 0; i < strokes; i++) {
    const hue = (baseHue + (rnd() - 0.5) * 180 + 360) % 360;
    const x1 = rnd() * width;
    const y1 = rnd() * height;
    const x2 = x1 + (rnd() - 0.5) * width * 0.4;
    const y2 = y1 + (rnd() - 0.5) * height * 0.15;
    parts.push(
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${hsl(hue, 25 + rnd() * 40, 25 + rnd() * 50)}" stroke-width="${(width * (0.004 + rnd() * 0.012)).toFixed(1)}" stroke-linecap="round" opacity="${(0.3 + rnd() * 0.4).toFixed(2)}"/>`,
    );
  }
  const blur = Math.max(width, height) * 0.02;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${blur.toFixed(1)}"/></filter></defs><rect width="100%" height="100%" fill="${ground}"/>${parts.join("")}</svg>`;
}

/** Pixel size for a painting of `heightMm × widthMm` with the long side `longSide` px. */
export function proceduralSize(
  heightMm: number,
  widthMm: number,
  longSide = 1600,
): { width: number; height: number } {
  if (widthMm >= heightMm) {
    return {
      width: longSide,
      height: Math.round((longSide * heightMm) / widthMm),
    };
  }
  return {
    width: Math.round((longSide * widthMm) / heightMm),
    height: longSide,
  };
}
