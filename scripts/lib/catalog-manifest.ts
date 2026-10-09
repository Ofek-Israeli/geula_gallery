/**
 * `data/catalog/manifest.json`: the painter's works, read by the catalog and orders seeds.
 *
 * The images in `data/catalog/images/` are web-size (2000 px) JPEGs edited from the painter's
 * own RAW photos (cropped to the canvas, perspective-corrected, levelled, sRGB). Prices come from
 * the pricing formula (`src/lib/price-formula.ts`, docs/pricing/pricing-procedure.tex); every
 * seeded work stays a demo listing (`is_demo = true`) until the painter confirms the prices for
 * live sales.
 * The 16 `fixture` works keep the commerce roles the tests rely on (statuses, test prices, flags,
 * `sampleOrder`), but only in `db:reset --seed fixtures`; the `demo` seed lists them like every
 * other work (`asCatalogWork`).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { formulaPriceIls, formulaPriceUsd } from "@/lib/price-formula";

export const MANIFEST_PATH = "data/catalog/manifest.json";
export const CATALOG_IMAGES_DIR = "data/catalog/images";

const localized = z.object({ he: z.string().min(1), en: z.string().min(1) });
const text = z.object({ he: z.string(), en: z.string() });

export const catalogImageSchema = z.object({
  /** Repo-relative path under `data/catalog/images/`. */
  file: z.string().startsWith(`${CATALOG_IMAGES_DIR}/`),
  role: z.enum(["MAIN", "FRAMED"]),
  alt: localized,
});

export const catalogWorkSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  title: localized,
  /** Only where the signature shows the year. */
  yearCreated: z.number().int().min(1800).max(2100).nullable(),
  medium: z.enum(["OIL", "ACRYLIC"]),
  surface: z.enum(["CANVAS"]),
  mediumDetail: localized,
  heightMm: z.number().int().positive(),
  widthMm: z.number().int().positive(),
  /** The size is a placeholder (the photo's filename had none); the description says TODO. */
  sizeTodo: z.boolean(),
  framed: z.boolean(),
  signed: z.boolean(),
  series: z.string().min(1),
  status: z.enum(["AVAILABLE", "ON_HOLD", "SOLD", "NOT_FOR_SALE"]),
  holdReason: z.literal("RESERVED_OFFLINE").nullable(),
  /**
   * Whole shekels / dollars. Fixture works: their test prices. Other works: the formula price
   * (`src/lib/price-formula.ts`), which the demo seed recomputes anyway.
   */
  priceIls: z.number().int().positive().nullable(),
  priceUsd: z.number().int().positive().nullable(),
  canBeRolled: z.boolean(),
  crate: z.boolean(),
  quoteOnly: z.boolean(),
  shipsInternationally: z.boolean(),
  featured: z.boolean(),
  sortOrder: z.number().int(),
  /** One of the 16 works the test suites seed (`--seed fixtures`). */
  fixture: z.boolean(),
  sampleOrder: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
  description: text,
  /** MAIN first; framed works add a FRAMED view. */
  images: z
    .array(catalogImageSchema)
    .min(1)
    .refine((imgs) => imgs[0]?.role === "MAIN", "the first image must be MAIN")
    .refine(
      (imgs) => imgs.filter((i) => i.role === "MAIN").length === 1,
      "exactly one MAIN image",
    ),
});
export type CatalogWork = z.infer<typeof catalogWorkSchema>;

/**
 * A work as the `demo` seed lists it, i.e. the painter's real catalog: available, priced by the
 * formula, with the default shipping flags. A fixture's test roles (status, test prices,
 * quote-only, crate, rolled, domestic-only) apply only to the `fixtures` seed.
 */
export function asCatalogWork(w: CatalogWork): CatalogWork {
  const priceIls = formulaPriceIls(w);
  return {
    ...w,
    status: "AVAILABLE",
    holdReason: null,
    priceIls,
    priceUsd: formulaPriceUsd(priceIls),
    canBeRolled: false,
    crate: false,
    quoteOnly: false,
    shipsInternationally: true,
  };
}

export const catalogManifestSchema = z
  .object({
    version: z.literal(1),
    series: z.array(
      z.object({ slug: z.string(), name: localized, sortOrder: z.number() }),
    ),
    works: z.array(catalogWorkSchema).min(1),
  })
  .superRefine((m, ctx) => {
    const slugs = new Set<string>();
    const seriesSlugs = new Set(m.series.map((s) => s.slug));
    for (const w of m.works) {
      if (slugs.has(w.slug)) {
        ctx.addIssue({ code: "custom", message: `duplicate slug ${w.slug}` });
      }
      slugs.add(w.slug);
      if (!seriesSlugs.has(w.series)) {
        ctx.addIssue({
          code: "custom",
          message: `${w.slug}: unknown series ${w.series}`,
        });
      }
      if (w.sampleOrder !== null && !w.fixture) {
        ctx.addIssue({
          code: "custom",
          message: `${w.slug}: a sample-order work must be a fixture`,
        });
      }
    }
    for (const n of [1, 2, 3] as const) {
      if (m.works.filter((w) => w.sampleOrder === n).length !== 1) {
        ctx.addIssue({
          code: "custom",
          message: `exactly one work needs sampleOrder ${n}`,
        });
      }
    }
  });
export type CatalogManifest = z.infer<typeof catalogManifestSchema>;

export async function readCatalogManifest(
  root = process.cwd(),
): Promise<CatalogManifest> {
  const raw = await readFile(path.join(root, MANIFEST_PATH), "utf8");
  return catalogManifestSchema.parse(JSON.parse(raw));
}
