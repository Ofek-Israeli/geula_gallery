import "server-only";

/**
 * A hand-written single-page PDF (spec §4.4 mock carrier: "a hand-written ASCII PDF label").
 * Helvetica text lines only; non-ASCII characters are replaced by `?` (the mock label is Latin by
 * design, like a real carrier label). The byte offsets of the cross-reference table are computed,
 * so PDF readers open it without repair.
 */
export interface MinimalPdfOptions {
  /** Page size in points; default 4 × 6 in (288 × 432), the usual label size. */
  width?: number;
  height?: number;
  /** Font size of the first line (a title); the rest use `fontSize`. */
  titleSize?: number;
  fontSize?: number;
}

function pdfString(text: string): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, "?");
  return `(${ascii.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

export function minimalPdf(
  lines: readonly string[],
  opts: MinimalPdfOptions = {},
): Uint8Array {
  const width = opts.width ?? 288;
  const height = opts.height ?? 432;
  const titleSize = opts.titleSize ?? 18;
  const fontSize = opts.fontSize ?? 10;
  const margin = 24;

  const ops: string[] = ["BT"];
  let y = height - margin - titleSize;
  lines.forEach((line, i) => {
    const size = i === 0 ? titleSize : fontSize;
    ops.push(
      `/F1 ${size} Tf`,
      `1 0 0 1 ${margin} ${y} Tm`,
      `${pdfString(line)} Tj`,
    );
    y -= Math.round(size * 1.5);
  });
  ops.push("ET");
  const content = ops.join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets)
    out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
