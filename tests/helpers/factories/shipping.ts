/**
 * Shipping test factories (WS3-owned, spec §9.3: streams add `factories/<stream>.ts`).
 *
 * - Pure builders: `sampleShipmentRequest`, `carrierEnv`, `dhlFixture`, `fixtureFetch` (a
 *   fixture-replaying `fetch` that records every request for the DHL contract and unit tests).
 * - DB arrangers (integration tests): `paidShipmentOrder` drives the real checkout, mock payment
 *   and finalize services, then returns the order and its shipment row.
 *
 * App modules are imported lazily, like `factories/core.ts`, so importing this file never parses
 * the app environment and never loads `server-only` code (Playwright specs may import it).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "@/server/env";
import type { CreateShipmentRequest } from "@/server/shipping/types";

const FIXTURES = fileURLToPath(new URL("../../fixtures/dhl/", import.meta.url));

/** A synthetic DHL fixture (`tests/fixtures/dhl/<name>.json`). */
export function dhlFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8"));
}

/** The environment fields the carriers read, with test values. */
export function carrierEnv(overrides: Partial<Env> = {}): Env {
  return {
    SHIPPING_CARRIER: "mock",
    DHL_EXPRESS_MODE: "test",
    DHL_API_KEY: "test-dhl-key",
    DHL_API_SECRET: "test-dhl-secret",
    DHL_ACCOUNT_NUMBER: "TESTACCOUNT",
    DHL_PAPERLESS_TRADE: false,
    MOCK_CARRIER_DELIVERY_SECONDS: 60,
    ...overrides,
  } as Env;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

export interface FixtureRoute {
  method: string;
  /** Matched against `url.pathname` (string = suffix). */
  path: string | RegExp;
  status: number;
  body?: unknown;
  /** Throw instead of answering (e.g. a timeout `DOMException`). */
  error?: Error;
}

/** A `fetch` that answers from `routes` and records the requests (unmatched → 599). */
export function fixtureFetch(routes: FixtureRoute[]) {
  const requests: RecordedRequest[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const text = await request.text();
    requests.push({
      method: request.method,
      url,
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
    });
    const route = routes.find(
      (r) =>
        r.method === request.method &&
        (typeof r.path === "string"
          ? url.pathname.endsWith(r.path)
          : r.path.test(url.pathname)),
    );
    if (!route) return new Response("no fixture", { status: 599 });
    if (route.error) throw route.error;
    return new Response(
      route.body === undefined ? null : JSON.stringify(route.body),
      {
        status: route.status,
        headers: { "content-type": "application/json" },
      },
    );
  };
  return { fetch, requests };
}

/** A valid international `CreateShipmentRequest` (Latin, placeholder contacts). */
export function sampleShipmentRequest(
  overrides: Partial<CreateShipmentRequest> = {},
): CreateShipmentRequest {
  return {
    orderNumber: "GG-TEST01",
    plannedShippingDate: "2026-10-05",
    shipper: {
      name: "Test Shipper",
      companyName: "Test Studio",
      email: "studio@example.com",
      address: {
        name: "Test Shipper",
        line1: "1 Test Street",
        city: "Tel Aviv",
        postalCode: "6100000",
        country: "IL",
        phone: "+97230000000",
      },
    },
    recipient: {
      name: "Test Receiver",
      email: "buyer@example.test",
      address: {
        name: "Test Receiver",
        line1: "1 Example Avenue",
        line2: "Apt 2",
        city: "New York",
        region: "NY",
        postalCode: "10001",
        country: "US",
        phone: "+97230000000",
      },
    },
    packages: [{ lengthMm: 425, widthMm: 425, heightMm: 90, weightG: 2058 }],
    isCustomsDeclarable: true,
    declaredValueMinor: 87_000,
    declaredCurrency: "USD",
    insuredValueMinor: 87_000,
    incoterm: "DAP",
    exportReason: "permanent",
    invoiceNumber: "CI-GG-TEST01",
    contentsDescriptionEn: "Original painting (oil on cardboard)",
    lineItems: [
      {
        description:
          "Original painting, oil on cardboard, by Test Artist (2024). Hand-painted unique work of art, not a reproduction.",
        quantity: 1,
        valueMinor: 87_000,
        exportCommodityCode: "9701910000",
        importCommodityCode: "9701.91.0000",
        originCountry: "IL",
        weightG: 2058,
      },
    ],
    paperlessTrade: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------- DB arrangers (integration)

type AdminContext = import("@/server/domain/admin").AdminContext;
type ArtworkInsert = typeof import("@/server/db/schema").artworks.$inferInsert;

/** An `AdminContext` for service calls in integration tests. */
export function testAdminContext(userId = "u-ship"): AdminContext {
  return {
    userId,
    email: `${userId}@example.test`,
    name: "Shipping Admin",
    sessionId: `s-${userId}`,
    sessionCreatedAt: new Date(),
    twoFactorEnabled: true,
    locale: "he",
    ipHash: null,
    actor: `admin:${userId}`,
  } as unknown as AdminContext;
}

export interface PaidOrderOptions {
  country?: string;
  method?: "CARRIER_TABLE" | "LOCAL_PICKUP" | "ARTIST_DELIVERY";
  currency?: "ILS" | "USD";
  artwork?: Partial<ArtworkInsert>;
}

/**
 * A PAID order with its shipment row, through the real services: checkout → mock "pay" →
 * `finalizeAttempt`. Defaults: Israel, courier (CARRIER_TABLE), ILS.
 */
export async function paidShipmentOrder(opts: PaidOrderOptions = {}) {
  const [{ db }, schema, { eq }, commerce, { finalizeAttempt }] =
    await Promise.all([
      import("@/server/db/client"),
      import("@/server/db/schema"),
      import("drizzle-orm"),
      import("./commerce"),
      import("@/server/payments/finalize"),
    ]);
  const country = opts.country ?? "IL";
  const art = await commerce.buyableArtwork(db, opts.artwork);
  const h = await commerce.heldOrder(art.slug, {
    country,
    method: opts.method ?? "CARRIER_TABLE",
    currency: opts.currency ?? (country === "IL" ? "ILS" : "USD"),
  });
  await commerce.clickMockPay(h.ref, "pay");
  const { result } = await finalizeAttempt(h.attemptId, { trigger: "return" });
  if (result.outcome !== "paid") {
    throw new Error(`paidShipmentOrder: finalize → ${result.outcome}`);
  }
  const [shipment] = await db
    .select()
    .from(schema.shipments)
    .where(eq(schema.shipments.orderId, h.orderId));
  if (!shipment) throw new Error("paidShipmentOrder: no shipment row");
  return {
    orderId: h.orderId,
    shipmentId: shipment.id,
    artwork: art,
    ref: h.ref,
  };
}

/** A storage key shaped like a `purpose=packing` upload (no file needed by the services). */
export function packingPhotoKey(n = 1): string {
  const hex = n.toString(16).padStart(12, "0");
  return `packing/2026/10/00000000-0000-4000-8000-${hex}.jpg`;
}

/** The packed parcel of a small work and every checklist item ticked. */
export function fullPacking(photoKeys: string[] = [packingPhotoKey()]) {
  return {
    checklist: [
      "noContactWithPaint",
      "cornerProtectors",
      "rigidSpacer",
      "tubeAtLeast10in",
      "rolledPaintOutward",
      "crateIspmExempt",
      "workCured",
      "coaSigned",
      "disclosureInserted",
      "receiptPrinted",
    ],
    packages: [{ lengthMm: 920, widthMm: 720, heightMm: 110, weightG: 4500 }],
    photoKeys,
  };
}

// ---------------------------------------------------------------- E2E arrangers (raw SQL)

export interface E2EPaidOrder {
  orderId: string;
  orderNumber: string;
  artworkId: string;
  buyerEmail: string;
}

/**
 * Arranges a PAID order directly in the E2E database (spec §10.4 `fulfill`): an **unpublished**
 * SOLD demo artwork (so no public page or grid changes), the order with a SUCCEEDED mock attempt
 * bound to its quote, the ONLINE sale and the shipment row – the same rows
 * `applySuccessfulPayment` writes. Used because the fulfillment specs test the admin screen, not
 * the checkout, and must not buy (and so sell out) the shared demo works other specs use.
 */
export async function e2eArrangePaidOrder(
  connectionString: string,
  o: {
    country: "IL" | "US";
    method: "CARRIER_TABLE" | "LOCAL_PICKUP";
    disclosureSent?: boolean;
    locale?: "he" | "en";
  },
): Promise<E2EPaidOrder> {
  const pg = (await import("pg")).default;
  const { randomUUID } = await import("node:crypto");
  const { uniqueBuyer, testOrderNumber, uniqueSuffix } = await import("./core");
  const client = new pg.Client({
    connectionString,
    application_name: "geula-e2e-arrange",
  });
  await client.connect();
  const intl = o.country !== "IL";
  const currency = intl ? "USD" : "ILS";
  const price = intl ? 87_000 : 320_000;
  const shipping = o.method === "LOCAL_PICKUP" ? 0 : intl ? 9_600 : 6_000;
  const total = price + shipping;
  const buyer = uniqueBuyer("e2e-fulfill");
  const number = testOrderNumber();
  try {
    await client.query("BEGIN");
    const s = uniqueSuffix();
    const art = await client.query<{ id: string }>(
      `INSERT INTO artworks (slug, title_he, title_en, medium, surface, height_mm, width_mm, depth_mm,
         orientation, size_bucket, price_ils_minor, price_usd_minor, is_published, sale_status, sold_at,
         is_demo, packaging_type, packed_length_mm, packed_width_mm, packed_height_mm, packed_weight_g,
         ships_internationally, coa_included, medium_detail_he, medium_detail_en, year_created)
       VALUES ($1, $2, $3, 'OIL', 'CANVAS', 600, 800, 30, 'LANDSCAPE', 'M', 320000, 87000, false,
         'SOLD', now(), true, 'STRETCHED_BOX', 920, 720, 110, 4500, true, true,
         'שמן על בד', 'Oil on canvas', 2024)
       RETURNING id`,
      [`e2e-ship-${s}`, `יצירת משלוח ${s}`, `Shipping test work ${s}`],
    );
    const artworkId = art.rows[0]?.id as string;
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (number, source, status, locale, currency, is_demo, items_total_minor,
         shipping_minor, insurance_minor, total_minor, vat_mode, vat_rate_bp, vat_minor, ship_country,
         ship_name, ship_line1, ship_city, ship_postal_code, ship_phone, shipping_method,
         buyer_name, buyer_email, buyer_phone, receipt_email_consent, terms_accepted_at,
         age_confirmed_at, disclosure_sent_at, disclosure_version)
       VALUES ($1, 'WEB', 'AWAITING_PAYMENT', $2, $3, true, $4, $5, 0, $6, 'OSEK_PATUR', 0, 0, $7,
         $8, $9, $10, $11, '+97230000000', $12, $8, $13, '+97230000000', true, now(), now(), $14, $15)
       RETURNING id`,
      [
        number,
        o.locale ?? "he",
        currency,
        price,
        shipping,
        total,
        o.country,
        buyer.name,
        o.method === "LOCAL_PICKUP"
          ? null
          : intl
            ? "1 Example Avenue"
            : "Herzl 1",
        o.method === "LOCAL_PICKUP" ? null : intl ? "New York" : "Tel Aviv",
        o.method === "LOCAL_PICKUP" ? null : intl ? "10001" : "6100000",
        o.method,
        buyer.email,
        o.disclosureSent ? new Date() : null,
        o.disclosureSent ? "e2e" : null,
      ],
    );
    const orderId = order.rows[0]?.id as string;
    const item = await client.query<{ id: string }>(
      `INSERT INTO order_items (order_id, artwork_id, title_he, title_en, price_minor, currency)
       SELECT $1, id, title_he, title_en, $2, $3 FROM artworks WHERE id = $4 RETURNING id`,
      [orderId, price, currency, artworkId],
    );
    const attempt = await client.query<{ id: string }>(
      `INSERT INTO payment_attempts (order_id, seq, provider, provider_mode, merchant_ref, is_demo,
         status, quote_version, amount_minor, currency, provider_ref, finalized_at)
       VALUES ($1, 1, 'MOCK', 'MOCK', 'mock-merchant', true, 'SUCCEEDED', 1, $2, $3, $4, now())
       RETURNING id`,
      [orderId, total, currency, `mock_${randomUUID().replace(/-/g, "")}`],
    );
    await client.query(
      `UPDATE orders SET status = 'PAID', paid_attempt_id = $2, paid_at = now() WHERE id = $1`,
      [orderId, attempt.rows[0]?.id],
    );
    await client.query(
      `INSERT INTO sales (artwork_id, order_id, order_item_id, channel, price_minor, currency, is_mock, created_by)
       VALUES ($1, $2, $3, 'ONLINE', $4, $5, true, 'e2e')`,
      [artworkId, orderId, item.rows[0]?.id, price, currency],
    );
    await client.query(
      `INSERT INTO shipments (order_id, method, carrier, declared_value_minor, declared_currency,
         hs_code, origin_country, incoterm, reason_for_export, commercial_invoice_number,
         export_decl_status, charged_to_buyer_minor)
       VALUES ($1, $2, $3, $4, $5, '9701.91', 'IL', $6, $7, $8, $9, $10)`,
      [
        orderId,
        o.method,
        o.method === "LOCAL_PICKUP" ? null : intl ? "MOCK" : "MANUAL",
        price,
        currency,
        intl ? "DAP" : null,
        intl ? "permanent" : null,
        intl ? `CI-${number}` : null,
        intl ? "REQUIRED" : "NOT_REQUIRED",
        shipping,
      ],
    );
    await client.query("COMMIT");
    return { orderId, orderNumber: number, artworkId, buyerEmail: buyer.email };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
