import "server-only";
import sharp from "sharp";

/**
 * Open Graph image (spec §4.6, §6.6): 1200×630, text-free. The artwork is never cropped: it is
 * fitted inside the frame with a margin on the gallery's white background ("white cube").
 */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
const MARGIN = 40;
const BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 };

/** `source` is an sRGB, EXIF-free web master (see `ingest.ts`). Returns a JPEG. */
export async function renderOgImage(source: Uint8Array): Promise<Uint8Array> {
  const fitted = await sharp(source)
    .resize({
      width: OG_WIDTH - 2 * MARGIN,
      height: OG_HEIGHT - 2 * MARGIN,
      fit: "inside",
      withoutEnlargement: false,
    })
    .toBuffer();
  const out = await sharp({
    create: {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      channels: 3,
      background: BACKGROUND,
    },
  })
    .composite([{ input: fitted, gravity: "center" }])
    .withIccProfile("srgb")
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return new Uint8Array(out);
}
