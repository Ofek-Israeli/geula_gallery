/**
 * Parses an Art Institute of Chicago `dimensions` string into integer millimetres (spec §8.2
 * "Data traps"). Only the first `;` segment is read: five of the demo works append
 * "; Framed: …" (94241, 100476, 270002, 109693, 66144), and the frame must never be taken for
 * the painting.
 *
 *   "65.3 × 92.3 cm (25 3/4 × 36 3/8 in.); Framed: 82.6 × 108.6 × 6.4 cm (…)"
 *     → { heightMm: 653, widthMm: 923, depthMm: null }
 *
 * AIC lists height first. Accepts `×` or `x` as the separator.
 */
export interface AicDimensions {
  heightMm: number;
  widthMm: number;
  depthMm: number | null;
}

const CM_RE =
  /(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)(?:\s*[×x]\s*(\d+(?:\.\d+)?))?\s*cm\b/i;

const toMm = (cm: string) => Math.round(Number(cm) * 10);

export function parseAicDimensions(raw: string): AicDimensions | null {
  const first = raw.split(";")[0]?.trim() ?? "";
  const m = CM_RE.exec(first);
  if (!m?.[1] || !m[2]) return null;
  const heightMm = toMm(m[1]);
  const widthMm = toMm(m[2]);
  if (heightMm <= 0 || widthMm <= 0) return null;
  return { heightMm, widthMm, depthMm: m[3] ? toMm(m[3]) : null };
}

/**
 * The artist's name from `artist_display` (first line, nationality and dates removed):
 * "Marsden Hartley (American, 1877–1943)" → "Marsden Hartley";
 * "Attributed to Henri Edmond Cross\nFrench, 1856-1910" → "Attributed to Henri Edmond Cross"
 * (the attribution is kept, spec §8.2).
 */
export function aicArtistName(artistDisplay: string): string {
  const firstLine = artistDisplay.split("\n")[0]?.trim() ?? "";
  return firstLine.replace(/\s*\([^)]*\)\s*$/, "").trim();
}
