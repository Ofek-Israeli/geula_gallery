import { and, eq, isNull, sql } from "drizzle-orm";
import { artworks, sales } from "@/server/db/schema";
import { readDemoManifest } from "../lib/demo-manifest";
import type { SeedModule } from "./types";

/**
 * Sample-order seed — M2 STUB. Owner: WS6, which replaces it with the three sample orders of spec
 * §8.4 (SUCCEEDED MOCK attempts bound to their quote version, ONLINE `is_mock` sales, ISSUED mock
 * receipts, shipments; no outbox jobs).
 *
 * Until then it only gives the three sold demo works (manifest `sampleOrder` 1–3: 94241, 64754,
 * 30928) their state: an OFFLINE `is_mock` sale at the list price and `sale_status = SOLD`, in one
 * transaction per work that locks the artwork first (global lock order). Idempotent: a work that
 * already has an active sale is skipped. Sold dates are staggered (30, 10 and 3 days ago) so the
 * "Recently sold" strip has an order.
 */
const DAYS_AGO: Record<1 | 2 | 3, number> = { 1: 30, 2: 10, 3: 3 };

export const ordersSeed: SeedModule = {
  name: "orders",
  modes: ["demo"],
  async run({ db, log }) {
    const manifest = await readDemoManifest();
    let marked = 0;
    for (const w of manifest.works) {
      if (w.sampleOrder === null || w.status !== "SOLD") continue;
      const soldAt = new Date(
        Date.now() - DAYS_AGO[w.sampleOrder] * 86_400_000,
      );
      const done = await db.transaction(async (tx) => {
        const [art] = await tx
          .select({
            id: artworks.id,
            status: artworks.saleStatus,
            price: artworks.priceIlsMinor,
          })
          .from(artworks)
          .where(eq(artworks.slug, w.slug))
          .for("update");
        if (!art) throw new Error(`orders seed: artwork ${w.slug} not found`);
        const [active] = await tx
          .select({ id: sales.id })
          .from(sales)
          .where(and(eq(sales.artworkId, art.id), isNull(sales.voidedAt)))
          .limit(1);
        if (active || art.status !== "AVAILABLE") return false;
        await tx.insert(sales).values({
          artworkId: art.id,
          channel: "OFFLINE",
          priceMinor: art.price ?? 0,
          currency: "ILS",
          isMock: true,
          soldAt,
          createdBy: "seed",
        });
        const updated = await tx
          .update(artworks)
          .set({ saleStatus: "SOLD", soldAt, updatedAt: sql`now()` })
          .where(
            and(
              eq(artworks.id, art.id),
              eq(artworks.saleStatus, "AVAILABLE"),
              isNull(artworks.reservedByOrderId),
            ),
          )
          .returning({ id: artworks.id });
        if (updated.length !== 1) {
          throw new Error(`orders seed: could not mark ${w.slug} SOLD`);
        }
        return true;
      });
      if (done) marked++;
    }
    log(
      `orders: stub, ${marked} demo works marked SOLD via OFFLINE mock sales (sample orders land in WS6)`,
    );
  },
};
