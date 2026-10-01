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
