import "server-only";
import { createHash } from "node:crypto";
import sharp, { type Metadata, type Sharp } from "sharp";
import { renderOgImage } from "./og";

/**
 * Image ingest (sharp 0.35.5, spec §4.6).
 * - Accepts only JPEG, PNG and WebP (sniffed from the bytes, never the file name); `limitInputPixels`
 *   100 M guards against decompression bombs.
 * - Outputs are ICC-aware conversions to sRGB with an embedded sRGB profile; EXIF (including GPS),
 *   XMP and IPTC are stripped; EXIF orientation is applied first (`.rotate()`).
 * - Artwork: web master (long side ≤ 2400 px, q85 mozjpeg), 16 px WebP blur placeholder, dominant
 *   colour, 1200×630 text-free OG image; the untouched original goes to private storage.
 * - Packing / return photos: private only, rotated, stripped and downscaled to 2400 px.
 */
export const ACCEPTED_FORMATS = ["jpeg", "png", "webp"] as const;
export type AcceptedFormat = (typeof ACCEPTED_FORMATS)[number];
export const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
export const LIMIT_INPUT_PIXELS = 100_000_000;
export const MASTER_LONG_SIDE = 2400;
export const MASTER_QUALITY = 85;
export const BLUR_SIZE = 16;

export class UnsupportedImageError extends Error {
  constructor(
    public readonly reason:
      | "format"
      | "too_large"
      | "corrupt"
      | "too_many_pixels",
  ) {
    super(`unsupported image: ${reason}`);
    this.name = "UnsupportedImageError";
  }
}

function open(input: Uint8Array): Sharp {
  return sharp(input, {
    limitInputPixels: LIMIT_INPUT_PIXELS,
    failOn: "error",
    // Only the first frame/page (animated WebP, multi-page inputs).
    pages: 1,
  });
}

export interface ProbedImage {
  format: AcceptedFormat;
  width: number;
  height: number;
}

/** Reads the header only. Rejects anything that is not a decodable JPEG, PNG or WebP. */
export async function probeImage(input: Uint8Array): Promise<ProbedImage> {
  if (input.byteLength === 0) throw new UnsupportedImageError("corrupt");
  if (input.byteLength > MAX_UPLOAD_BYTES)
    throw new UnsupportedImageError("too_large");
  let meta: Metadata;
  try {
    meta = await open(input).metadata();
  } catch {
    throw new UnsupportedImageError("corrupt");
  }
  const format = meta.format as string | undefined;
  if (!format || !(ACCEPTED_FORMATS as readonly string[]).includes(format)) {
    throw new UnsupportedImageError("format");
  }
  if (!meta.width || !meta.height) throw new UnsupportedImageError("corrupt");
  if (meta.width * meta.height > LIMIT_INPUT_PIXELS) {
    throw new UnsupportedImageError("too_many_pixels");
  }
  return {
    format: format as AcceptedFormat,
    width: meta.width,
    height: meta.height,
  };
}

/** EXIF-rotated, sRGB, metadata-free pipeline bounded to `longSide`. */
function normalized(input: Uint8Array, longSide: number): Sharp {
  return open(input)
    .rotate()
    .resize({
      width: longSide,
      height: longSide,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toColourspace("srgb")
    .withIccProfile("srgb");
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
}

export function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

export interface IngestedArtworkImage {
  format: AcceptedFormat;
  /** sha256 hex of the uploaded bytes. */
  contentHash: string;
  original: {
    body: Uint8Array;
    contentType: string;
    ext: "jpg" | "png" | "webp";
  };
  master: { body: Uint8Array; width: number; height: number; bytes: number };
  og: { body: Uint8Array; width: 1200; height: 630 };
  blurDataUrl: string;
  /** `#rrggbb` */
  dominantColor: string;
}

export async function ingestArtworkImage(
  input: Uint8Array,
): Promise<IngestedArtworkImage> {
  const probed = await probeImage(input);
  const contentHash = createHash("sha256").update(input).digest("hex");

  const { data: master, info } = await normalized(input, MASTER_LONG_SIDE)
    .jpeg({ quality: MASTER_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  const blur = await sharp(master)
    .resize(BLUR_SIZE, BLUR_SIZE, { fit: "inside" })
    .webp({ quality: 40 })
    .toBuffer();

  const { dominant } = await sharp(master).stats();
  const og = await renderOgImage(master);

  const ext = probed.format === "jpeg" ? "jpg" : probed.format;
  return {
    format: probed.format,
    contentHash,
    original: {
      body: input,
      contentType: `image/${probed.format}`,
      ext,
    },
    master: {
      body: new Uint8Array(master),
      width: info.width,
      height: info.height,
      bytes: info.size,
    },
    og: { body: og, width: 1200, height: 630 },
    blurDataUrl: `data:image/webp;base64,${blur.toString("base64")}`,
    dominantColor: rgbToHex(dominant),
  };
}

export interface IngestedPrivatePhoto {
  body: Uint8Array;
  width: number;
  height: number;
  bytes: number;
  contentHash: string;
}

/** Packing and return photos: private only; no master, no OG (spec §4.6). */
export async function ingestPrivatePhoto(
  input: Uint8Array,
): Promise<IngestedPrivatePhoto> {
  await probeImage(input);
  const { data, info } = await normalized(input, MASTER_LONG_SIDE)
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    body: new Uint8Array(data),
    width: info.width,
    height: info.height,
    bytes: info.size,
    contentHash: createHash("sha256").update(input).digest("hex"),
  };
}
