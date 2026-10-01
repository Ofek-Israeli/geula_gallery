/**
 * Storefront test factories (WS1-owned, spec §9.3: streams add `factories/<stream>.ts`).
 *
 * The demo catalog has one image per work, so the lightbox and the mobile strip specs give one
 * work extra DETAIL images. They reuse the MAIN image's stored file (no upload), and the call is
 * idempotent: it replaces the work's non-MAIN images, so re-running a spec, or running it in
 * both Playwright projects, gives the same result.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";

/** Same resolution as playwright.config.ts (shell, then `.env.local`, then the default). */
export function storefrontE2eDatabaseUrl(): string {
  const local: Record<string, string | undefined> = existsSync(".env.local")
    ? parseEnv(readFileSync(".env.local", "utf8"))
    : {};
  return (
    process.env.E2E_DATABASE_URL?.trim() ||
    local.E2E_DATABASE_URL?.trim() ||
    "postgres://localhost:5432/geula_e2e"
  );
}

/**
 * Gives a published work `total` images: its MAIN image plus `total - 1` DETAIL copies with
 * their own bilingual alt texts ("Detail 1", …). Returns the number of images.
 */
export async function withGalleryImages(
  slug: string,
  total: number,
  connectionString = storefrontE2eDatabaseUrl(),
): Promise<number> {
  const client = new pg.Client({
    connectionString,
    application_name: "geula-e2e-storefront",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM artworks WHERE slug = $1 FOR UPDATE",
      [slug],
    );
    const artworkId = rows[0]?.id;
    if (!artworkId) throw new Error(`withGalleryImages: no artwork ${slug}`);
    await client.query(
      "DELETE FROM artwork_images WHERE artwork_id = $1 AND role <> 'MAIN'",
      [artworkId],
    );
    for (let n = 1; n < total; n++) {
      await client.query(
        `INSERT INTO artwork_images
           (artwork_id, role, sort_order, alt_he, alt_en, public_key, width, height, bytes,
            content_hash, blur_data_url, dominant_color, credit_line)
         SELECT artwork_id, 'DETAIL', $2, $3, $4, public_key, width, height, bytes,
                content_hash, blur_data_url, dominant_color, credit_line
           FROM artwork_images WHERE artwork_id = $1 AND role = 'MAIN'`,
        [artworkId, n, `פרט ${n}`, `Detail ${n}`],
      );
    }
    await client.query("COMMIT");
    return total;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
