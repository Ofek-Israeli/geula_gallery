/**
 * `data/demo-manifest.json` (spec §8.3): written by `npm run demo:fetch-images`, read by the
 * catalog seed. Everything the seed needs is here; the seed never calls the AIC API.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const MANIFEST_PATH = "data/demo-manifest.json";
export const DEMO_IMAGES_DIR = "data/demo-images";

const localized = z.object({ he: z.string().min(1), en: z.string().min(1) });

export const demoManifestWorkSchema = z.object({
  aicId: z.number().int().positive(),
  imageId: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: localized,
  artist: localized,
  date: localized,
  yearCreated: z.number().int().min(1800).max(2100),
  medium: z.enum(["OIL", "WATERCOLOR"]),
  surface: z.enum(["CANVAS", "BOARD", "CARDBOARD", "PAPER"]),
  mediumDetail: localized,
  heightMm: z.number().int().positive(),
  widthMm: z.number().int().positive(),
  series: z.string().min(1),
  status: z.enum(["AVAILABLE", "ON_HOLD", "SOLD", "NOT_FOR_SALE"]),
  holdReason: z.literal("RESERVED_OFFLINE").nullable(),
  priceIls: z.number().int().positive().nullable(),
  priceUsd: z.number().int().positive().nullable(),
  canBeRolled: z.boolean(),
  crate: z.boolean(),
  quoteOnly: z.boolean(),
  featured: z.boolean(),
  sortOrder: z.number().int(),
  sampleOrder: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  alt: localized,
  description: localized,
  aic: z.object({
    title: z.string(),
    artistDisplay: z.string(),
    dateDisplay: z.string(),
    mediumDisplay: z.string(),
    dimensions: z.string(),
    creditLine: z.string(),
    isPublicDomain: z.boolean(),
    url: z.string().url(),
  }),
  /** "Artist. Title, Date. The Art Institute of Chicago." (spec §6.2 /credits). */
  caption: z.string().min(1),
  license: z.literal("CC0-1.0"),
  image: z.object({
    file: z.string().min(1),
    sourceUrl: z.string().url(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    blurDataUrl: z.string().startsWith("data:image/webp;base64,"),
    dominantColor: z.string().regex(/^#[0-9a-f]{6}$/),
    fallback: z.boolean(),
  }),
});
export type DemoManifestWork = z.infer<typeof demoManifestWorkSchema>;

export const demoManifestSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  license: z.string(),
  fetchedOn: z.iso.date(),
  series: z.array(
    z.object({ slug: z.string(), name: localized, sortOrder: z.number() }),
  ),
  works: z.array(demoManifestWorkSchema).length(16),
});
export type DemoManifest = z.infer<typeof demoManifestSchema>;

export async function readDemoManifest(
  root = process.cwd(),
): Promise<DemoManifest> {
  const raw = await readFile(path.join(root, MANIFEST_PATH), "utf8");
  return demoManifestSchema.parse(JSON.parse(raw));
}
