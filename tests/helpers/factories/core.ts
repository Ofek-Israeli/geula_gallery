/**
 * Core test factories (spec §9.3: frozen at contracts-v1; streams add `factories/<stream>.ts`).
 *
 * - `uniqueSuffix()` / `uniqueBuyer()`: collision-free identities for parallel E2E specs and
 *   integration tests (`@example.test` addresses only; check-secrets allowlists them).
 * - `insertArtwork`, `insertOrder`, `insertPaymentAttempt`, `insertSale`: **schema-level** row
 *   builders with valid defaults. They write rows directly (no locks, no state machine, no
 *   outbox), so they are for arranging state and for constraint tests, never a substitute for
 *   the services under test.
 *
 * Playwright specs import this file for `uniqueBuyer()`, so it must not load `server-only`
 * modules at import time: schema modules are imported lazily inside the insert helpers.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { DbOrTx } from "@/server/db/client";

type Schema = typeof import("@/server/db/schema");
type ArtworkInsert = Schema["artworks"]["$inferInsert"];
type ArtworkRow = Schema["artworks"]["$inferSelect"];
type OrderInsert = Schema["orders"]["$inferInsert"];
type OrderRow = Schema["orders"]["$inferSelect"];
type OrderItemRow = Schema["orderItems"]["$inferSelect"];
type AttemptInsert = Schema["paymentAttempts"]["$inferInsert"];
type AttemptRow = Schema["paymentAttempts"]["$inferSelect"];
type SaleInsert = Schema["sales"]["$inferInsert"];
type SaleRow = Schema["sales"]["$inferSelect"];

const schema = (): Promise<Schema> => import("@/server/db/schema");

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Short random lowercase suffix, e.g. `k3q9p2a1`. */
export function uniqueSuffix(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b % 32];
  return out.toLowerCase();
}

/** `GG-` + 6 Crockford base32 characters (random; collisions are negligible in tests). */
export function testOrderNumber(): string {
  const bytes = randomBytes(6);
  let out = "GG-";
  for (const b of bytes) out += CROCKFORD[b % 32];
  return out;
}

export interface TestBuyer {
  name: string;
  email: string;
  phone: string;
}

/** A unique buyer with placeholder contact details (spec §10.4). */
export function uniqueBuyer(prefix = "buyer"): TestBuyer {
  const s = uniqueSuffix();
  return {
    name: `Test Buyer ${s.toUpperCase()}`,
    email: `${prefix}-${s}@example.test`,
    phone: "+972-3-000-0000",
  };
}

/** Insert a published, available ILS artwork. */
export async function insertArtwork(
  db: DbOrTx,
  overrides: Partial<ArtworkInsert> = {},
): Promise<ArtworkRow> {
  const { artworks } = await schema();
  const s = uniqueSuffix();
  const [row] = await db
    .insert(artworks)
    .values({
      slug: `test-${s}`,
      titleHe: `יצירת בדיקה ${s}`,
      titleEn: `Test work ${s}`,
      medium: "OIL",
      surface: "CANVAS",
      heightMm: 600,
      widthMm: 800,
      orientation: "LANDSCAPE",
      sizeBucket: "M",
      priceIlsMinor: 150_000,
      isPublished: true,
      publishedAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertArtwork: no row returned");
  return row;
}

export interface InsertOrderInput {
  /** Artworks to add as order items (price from `priceIlsMinor` or `priceUsdMinor`). */
  artworks: ArtworkRow[];
  overrides?: Partial<OrderInsert>;
}

/**
 * Insert an AWAITING_PAYMENT order (IL, local pickup, ILS, patur) with one item per artwork.
 * Totals are computed so the `orders_total_sum` CHECK holds unless `overrides` breaks it.
 */
export async function insertOrder(
  db: DbOrTx,
  input: InsertOrderInput,
): Promise<{ order: OrderRow; items: OrderItemRow[] }> {
  const { orders, orderItems } = await schema();
  const o = input.overrides ?? {};
  const currency = o.currency ?? "ILS";
  const price = (a: ArtworkRow) =>
    (currency === "ILS" ? a.priceIlsMinor : a.priceUsdMinor) ?? 100_000;
  const itemsTotal = input.artworks.reduce((sum, a) => sum + price(a), 0);
  const shipping = o.shippingMinor ?? 0;
  const insurance = o.insuranceMinor ?? 0;
  const buyer = uniqueBuyer();
  const [order] = await db
    .insert(orders)
    .values({
      number: testOrderNumber(),
      locale: "he",
      currency,
      itemsTotalMinor: itemsTotal,
      shippingMinor: shipping,
      insuranceMinor: insurance,
      totalMinor: itemsTotal + shipping + insurance,
      vatMode: "OSEK_PATUR",
      shipCountry: "IL",
      shippingMethod: "LOCAL_PICKUP",
      buyerName: buyer.name,
      buyerEmail: buyer.email,
      buyerPhone: buyer.phone,
      ...o,
    })
    .returning();
  if (!order) throw new Error("insertOrder: no row returned");
  const items =
    input.artworks.length === 0
      ? []
      : await db
          .insert(orderItems)
          .values(
            input.artworks.map((a) => ({
              orderId: order.id,
              artworkId: a.id,
              titleHe: a.titleHe,
              titleEn: a.titleEn,
              priceMinor: price(a),
              currency,
            })),
          )
          .returning();
  return { order, items };
}

/** Insert a MOCK payment attempt for `order` (status CREATED unless overridden). */
export async function insertPaymentAttempt(
  db: DbOrTx,
  order: Pick<OrderRow, "id" | "totalMinor" | "currency" | "quoteVersion">,
  overrides: Partial<AttemptInsert> = {},
): Promise<AttemptRow> {
  const { paymentAttempts } = await schema();
  const [row] = await db
    .insert(paymentAttempts)
    .values({
      orderId: order.id,
      seq: 1,
      provider: "MOCK",
      providerMode: "MOCK",
      merchantRef: "mock-merchant",
      isDemo: true,
      quoteVersion: order.quoteVersion,
      amountMinor: order.totalMinor,
      currency: order.currency,
      providerRef: `mock_${randomUUID()}`,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("insertPaymentAttempt: no row returned");
  return row;
}

/** Insert an active (not voided) sale. ONLINE sales need `orderId` (CHECK `sales_online_has_order`). */
export async function insertSale(
  db: DbOrTx,
  values: Pick<SaleInsert, "artworkId"> & Partial<SaleInsert>,
): Promise<SaleRow> {
  const { sales } = await schema();
  const [row] = await db
    .insert(sales)
    .values({
      channel: "OFFLINE",
      priceMinor: 150_000,
      currency: "ILS",
      createdBy: "test",
      ...values,
    })
    .returning();
  if (!row) throw new Error("insertSale: no row returned");
  return row;
}
