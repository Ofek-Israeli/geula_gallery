/**
 * `npm run demo:fetch-images [-- --offline] [--reuse] [--only <aicId,…>]` (spec §8.2).
 *
 * Run once in M2 by the commerce lead; the output (`data/demo-manifest.json`,
 * `data/demo-images/<aicId>.jpg`, all CC0) is committed, so nobody else needs network access.
 *
 * - Metadata in one request to the AIC API; any work whose `is_public_domain` is not true, or whose
 *   `image_id` differs from the curated one, is refused (the script exits non-zero).
 * - Images one at a time, ≥ 1 s apart, 3 retries with backoff, header
 *   `AIC-User-Agent: ${AIC_USER_AGENT}` (default: the project's GitHub URL). Content type must be
 *   `image/jpeg`.
 * - Processing (sharp): `.rotate()`, sRGB, metadata stripped, fit within 2000 px, q80 mozjpeg.
 * - Fallback: a deterministic procedural painting (`--offline`, or when a download fails), marked
 *   `fallback: true` in the manifest.
 * - `--reuse` keeps already processed images and only rebuilds the manifest (e.g. after editing
 *   alt texts in `scripts/lib/demo-curation.ts`); AIC metadata is still fetched unless `--offline`.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  DEMO_SERIES,
  DEMO_WORKS,
  type DemoWork,
  demoDescription,
  iiifUrl,
} from "./lib/demo-curation";
import {
  DEMO_IMAGES_DIR,
  type DemoManifest,
  type DemoManifestWork,
  demoManifestSchema,
  MANIFEST_PATH,
} from "./lib/demo-manifest";
import { aicArtistName, parseAicDimensions } from "./lib/parse-aic-dimensions";
import {
  proceduralPaintingSvg,
  proceduralSize,
} from "./lib/procedural-painting";

const DEFAULT_USER_AGENT =
  "geula-gallery-demo (https://github.com/Ofek-Israeli/geula_gallery)";
const USER_AGENT = process.env.AIC_USER_AGENT?.trim() || DEFAULT_USER_AGENT;
const API = "https://api.artic.edu/api/v1/artworks";
const FIELDS =
  "id,title,artist_display,date_display,medium_display,dimensions,image_id,credit_line,is_public_domain";
const MIN_GAP_MS = 1000;
const RETRIES = 3;
const MAX_SIDE = 2000;
const QUALITY = 80;

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const reuse = args.includes("--reuse");
const onlyIndex = args.indexOf("--only");
const only =
  onlyIndex >= 0 && args[onlyIndex + 1]
    ? new Set(
        (args[onlyIndex + 1] ?? "").split(",").map((s) => Number(s.trim())),
      )
    : null;

interface AicRecord {
  id: number;
  title: string;
  artist_display: string;
  date_display: string;
  medium_display: string;
  dimensions: string;
  image_id: string | null;
  credit_line: string;
  is_public_domain: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

/** Every AIC request goes through here: sequential, ≥ 1 s apart, retried with backoff. */
async function aicFetch(url: string, accept: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: {
          "AIC-User-Agent": USER_AGENT,
          "User-Agent": USER_AGENT,
          Accept: accept,
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchMetadata(
  works: readonly DemoWork[],
): Promise<Map<number, AicRecord>> {
  const ids = works.map((w) => w.aicId).join(",");
  const res = await aicFetch(
    `${API}?ids=${ids}&fields=${FIELDS}&limit=${works.length}`,
    "application/json",
  );
  const body = (await res.json()) as { data: AicRecord[] };
  return new Map(body.data.map((r) => [r.id, r]));
}

interface ProcessedImage {
  body: Buffer;
  width: number;
  height: number;
  fallback: boolean;
}

async function processJpeg(input: Uint8Array): Promise<ProcessedImage> {
  const { data, info } = await sharp(input, { limitInputPixels: 100_000_000 })
    .rotate()
    .resize({
      width: MAX_SIDE,
      height: MAX_SIDE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toColourspace("srgb")
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    body: data,
    width: info.width,
    height: info.height,
    fallback: false,
  };
}

async function proceduralImage(work: DemoWork): Promise<ProcessedImage> {
  const { width, height } = proceduralSize(work.heightMm, work.widthMm);
  const svg = proceduralPaintingSvg(work.aicId, width, height);
  const processed = await processJpeg(
    await sharp(Buffer.from(svg)).png().toBuffer(),
  );
  return { ...processed, fallback: true };
}

async function downloadImage(work: DemoWork): Promise<ProcessedImage> {
  const res = await aicFetch(iiifUrl(work), "image/jpeg");
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/jpeg")) {
    throw new Error(`unexpected content type "${type}" for ${work.aicId}`);
  }
  return processJpeg(new Uint8Array(await res.arrayBuffer()));
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function describeImage(body: Buffer) {
  const meta = await sharp(body).metadata();
  const blur = await sharp(body)
    .resize(16, 16, { fit: "inside" })
    .webp({ quality: 40 })
    .toBuffer();
  const { dominant } = await sharp(body).stats();
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    blurDataUrl: `data:image/webp;base64,${blur.toString("base64")}`,
    dominantColor: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`,
  };
}

function caption(work: DemoWork, aic: AicRecord | undefined): string {
  const artist = aic ? aicArtistName(aic.artist_display) : work.artist.en;
  const title = aic?.title ?? work.title.en;
  const date = aic?.date_display ?? work.date.en;
  return `${artist}. ${title}, ${date}. The Art Institute of Chicago.`;
}

async function readPrevious(): Promise<DemoManifest | null> {
  try {
    return demoManifestSchema.parse(
      JSON.parse(await readFile(MANIFEST_PATH, "utf8")),
    );
  } catch {
    return null;
  }
}

function validateMetadata(
  works: readonly DemoWork[],
  metadata: Map<number, AicRecord>,
): void {
  for (const w of works) {
    const r = metadata.get(w.aicId);
    if (!r) throw new Error(`AIC returned no record for ${w.aicId}`);
    if (r.is_public_domain !== true) {
      throw new Error(`${w.aicId} is not public domain; refused`);
    }
    if (r.image_id !== w.imageId) {
      throw new Error(
        `${w.aicId}: image_id ${r.image_id} differs from the curated ${w.imageId}`,
      );
    }
    const dims = parseAicDimensions(r.dimensions);
    if (
      !dims ||
      Math.abs(dims.heightMm - w.heightMm) > 1 ||
      Math.abs(dims.widthMm - w.widthMm) > 1
    ) {
      throw new Error(
        `${w.aicId}: AIC dimensions "${r.dimensions}" disagree with ${w.heightMm}×${w.widthMm} mm`,
      );
    }
  }
}

async function main(): Promise<void> {
  const previous = await readPrevious();
  await mkdir(DEMO_IMAGES_DIR, { recursive: true });

  let metadata = new Map<number, AicRecord>();
  if (!offline) {
    metadata = await fetchMetadata(DEMO_WORKS);
    validateMetadata(DEMO_WORKS, metadata);
    console.log(`[demo] metadata ok for ${DEMO_WORKS.length} works`);
  }

  const out: DemoManifestWork[] = [];
  const missingAlt: number[] = [];
  for (const [index, w] of DEMO_WORKS.entries()) {
    const prev = previous?.works.find((p) => p.aicId === w.aicId);
    const file = path.join(DEMO_IMAGES_DIR, `${w.aicId}.jpg`);
    const selected = !only || only.has(w.aicId);
    let fallback = prev?.image.fallback ?? false;

    if (selected && !(reuse && (await exists(file)))) {
      let img: ProcessedImage;
      if (offline) {
        img = await proceduralImage(w);
      } else {
        try {
          img = await downloadImage(w);
        } catch (error) {
          console.warn(
            `[demo] ${w.aicId}: download failed (${(error as Error).message}); using the procedural fallback`,
          );
          img = await proceduralImage(w);
        }
      }
      await writeFile(file, img.body);
      fallback = img.fallback;
      console.log(
        `[demo] ${w.aicId} ${w.slug}: ${img.width}×${img.height}${img.fallback ? " (fallback)" : ""}`,
      );
    } else if (!(await exists(file))) {
      throw new Error(`${file} is missing; run without --reuse/--only`);
    }

    if (!w.alt.he || !w.alt.en) missingAlt.push(w.aicId);
    const body = await readFile(file);
    const aic = metadata.get(w.aicId);
    const url = `https://www.artic.edu/artworks/${w.aicId}`;
    out.push({
      aicId: w.aicId,
      imageId: w.imageId,
      slug: w.slug,
      title: w.title,
      artist: w.artist,
      date: w.date,
      yearCreated: w.yearCreated,
      medium: w.medium,
      surface: w.surface,
      mediumDetail: w.mediumDetail,
      heightMm: w.heightMm,
      widthMm: w.widthMm,
      series: w.series,
      status: w.status,
      holdReason: w.holdReason ?? null,
      priceIls: w.priceIls,
      priceUsd: w.priceUsd,
      canBeRolled: w.canBeRolled ?? false,
      crate: w.crate ?? false,
      quoteOnly: w.quoteOnly ?? false,
      featured: w.featured ?? false,
      sortOrder: (index + 1) * 10,
      sampleOrder: w.sampleOrder ?? null,
      alt: w.alt,
      description: demoDescription(w),
      aic: aic
        ? {
            title: aic.title,
            artistDisplay: aic.artist_display,
            dateDisplay: aic.date_display,
            mediumDisplay: aic.medium_display,
            dimensions: aic.dimensions,
            creditLine: aic.credit_line,
            isPublicDomain: aic.is_public_domain,
            url,
          }
        : (prev?.aic ?? {
            title: w.title.en,
            artistDisplay: w.artist.en,
            dateDisplay: w.date.en,
            mediumDisplay: w.mediumDetail.en,
            dimensions: `${w.heightMm / 10} × ${w.widthMm / 10} cm`,
            creditLine: "",
            isPublicDomain: true,
            url,
          }),
      caption: aic ? caption(w, aic) : (prev?.caption ?? caption(w, undefined)),
      license: "CC0-1.0",
      image: {
        file: `${DEMO_IMAGES_DIR}/${w.aicId}.jpg`,
        sourceUrl: iiifUrl(w),
        ...(await describeImage(body)),
        fallback,
      },
    });
  }

  if (missingAlt.length > 0) {
    throw new Error(
      `alt texts missing in scripts/lib/demo-curation.ts for ${missingAlt.join(", ")}; images were written, manifest was not`,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const manifest: DemoManifest = {
    version: 1,
    source: "The Art Institute of Chicago API (https://api.artic.edu)",
    license:
      "Images and AIC metadata: CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). Hebrew titles, alt texts and descriptions were written for this project.",
    fetchedOn: offline || reuse ? (previous?.fetchedOn ?? today) : today,
    series: DEMO_SERIES.map((s, i) => ({ ...s, sortOrder: (i + 1) * 10 })),
    works: out,
  };
  demoManifestSchema.parse(manifest);
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  const fallbacks = out.filter((w) => w.image.fallback).length;
  console.log(
    `[demo] wrote ${MANIFEST_PATH} (${out.length} works, ${fallbacks} fallback images)`,
  );
}

await main();
