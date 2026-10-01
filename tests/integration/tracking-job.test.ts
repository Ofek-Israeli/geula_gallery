import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import { execSql } from "../helpers/factories/commerce";
import {
  carrierEnv,
  dhlFixture,
  fixtureFetch,
  fullPacking,
  paidShipmentOrder,
  testAdminContext,
} from "../helpers/factories/shipping";

/**
 * Spec §10.3 `tracking-job` (§5.6): selection, events recorded once, monotonic advance, one email
 * per new status, unknown codes recorded only, provider errors, the cron wrapper.
 */
const { db } = await import("@/server/db/client");
const { cronRuns, orders, outboxJobs, shipmentEvents, shipments } =
  await import("@/server/db/schema");
const svc = await import("@/server/shipping/shipments");
const { pollTracking, nextStatus } = await import("@/server/shipping/tracking");
const { createMockCarrier } = await import("@/server/shipping/carriers/mock");
const { createDhlCarrier } = await import("@/server/shipping/carriers/dhl");
const { runCronJob } = await import("@/server/jobs/index");
const { resetMockProviderHooks } = await import(
  "@/server/payments/providers/mock"
);
const { ProviderUnavailableError } = await import("@/server/integrations/http");
type CarrierAdapter = import("@/server/shipping/types").CarrierAdapter;
type NormalizedTrackingEvent =
  import("@/server/shipping/types").NormalizedTrackingEvent;

const ctx = testAdminContext();
cleanDatabaseBeforeEach();
beforeEach(() => resetMockProviderHooks());

const FAR = () => Date.now() + 30_000;

async function shipmentOf(orderId: string) {
  const [s] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, orderId));
  if (!s) throw new Error("no shipment");
  return s;
}
async function updateKeys(shipmentId: string) {
  const jobs = await db.select({ key: outboxJobs.dedupeKey }).from(outboxJobs);
  return jobs
    .map((j) => j.key)
    .filter((k) => k.startsWith(`email:shipment-update:${shipmentId}:`))
    .map((k) => k.split(":")[3])
    .sort();
}
async function makeStale(orderId: string) {
  await execSql(
    "UPDATE shipments SET last_tracked_at = now() - interval '2 hours' WHERE order_id = $1",
    [orderId],
  );
}

/** A labelled mock shipment (US, through the real services). */
async function labelled() {
  const o = await paidShipmentOrder({ country: "US" });
  await svc.savePacking(o.orderId, fullPacking(), ctx);
  await svc.saveCustoms(
    o.orderId,
    {
      hsCode: "9701.91",
      contentsDescriptionEn: "Original painting, oil on canvas.",
      declaredValueMinor: 40_000,
      insuredValueMinor: 0,
      exportDeclaration: { status: "PENDING_CARRIER" },
    },
    ctx,
  );
  const s = await shipmentOf(o.orderId);
  const res = await svc.requestLabel(s.id, ctx);
  expect(res.result.status).toBe("LABEL_CREATED");
  return { ...o, shipment: await shipmentOf(o.orderId) };
}

/** A stub adapter that answers `events` for any waybill. */
function stub(events: NormalizedTrackingEvent[] | Error): CarrierAdapter {
  return {
    id: "dhl",
    mode: "test",
    capabilities: {
      rates: false,
      labels: false,
      pickup: false,
      tracking: true,
      landedCost: false,
      paperlessTrade: false,
      insurance: false,
    },
    track: async () => {
      if (events instanceof Error) throw events;
      return { events };
    },
    trackingUrl: () => "",
  };
}

describe("nextStatus (monotonic advance)", () => {
  it("moves forward only, handles exceptions and ignores unknown codes", () => {
    expect(nextStatus("LABEL_CREATED", "IN_TRANSIT")).toEqual(["IN_TRANSIT"]);
    expect(nextStatus("LABEL_CREATED", "DELIVERED")).toEqual(["DELIVERED"]);
    expect(nextStatus("CUSTOMS", "IN_TRANSIT")).toEqual([]);
    expect(nextStatus("IN_TRANSIT", "IN_TRANSIT")).toEqual([]);
    expect(nextStatus("IN_TRANSIT", null)).toEqual([]);
    expect(nextStatus("OUT_FOR_DELIVERY", "EXCEPTION")).toEqual(["EXCEPTION"]);
    expect(nextStatus("EXCEPTION", "IN_TRANSIT")).toEqual(["IN_TRANSIT"]);
    expect(nextStatus("EXCEPTION", "DELIVERED")).toEqual(["DELIVERED"]);
    expect(nextStatus("EXCEPTION", "OUT_FOR_DELIVERY")).toEqual([
      "IN_TRANSIT",
      "OUT_FOR_DELIVERY",
    ]);
    expect(nextStatus("EXCEPTION", "RETURNED")).toEqual(["RETURNED"]);
  });
});

describe("pollTracking", () => {
  it("mock timeline: in transit, then out for delivery and delivered; one email per status", async () => {
    const o = await labelled();
    const t0 = new Date(o.shipment.updatedAt.getTime());
    const at = (ms: number) => () => new Date(t0.getTime() + ms);
    const mock = (ms: number) => () =>
      createMockCarrier({
        env: carrierEnv({ MOCK_CARRIER_DELIVERY_SECONDS: 10 }),
        now: at(ms),
      });

    // 4.5 s into a 10 s timeline: PU and AF.
    let r = await pollTracking({
      limit: 10,
      deadline: FAR(),
      adapterFor: mock(4_500),
      now: at(4_500),
    });
    expect(r).toMatchObject({ checked: 1, updated: 1, failed: 0 });
    let s = await shipmentOf(o.orderId);
    expect(s.status).toBe("IN_TRANSIT");
    expect(s.lastTrackedAt).not.toBeNull();

    // Tracked less than an hour ago: not selected.
    r = await pollTracking({
      limit: 10,
      deadline: FAR(),
      adapterFor: mock(20_000),
    });
    expect(r.checked).toBe(0);

    await makeStale(o.orderId);
    r = await pollTracking({
      limit: 10,
      deadline: FAR(),
      adapterFor: mock(20_000),
      now: at(20_000),
    });
    expect(r).toMatchObject({ checked: 1, updated: 1 });
    s = await shipmentOf(o.orderId);
    expect(s.status).toBe("DELIVERED");
    expect(s.deliveredAt).not.toBeNull();
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, o.orderId));
    expect(order?.deliveredAt?.toISOString()).toBe(
      s.deliveredAt?.toISOString(),
    );

    const polled = await db
      .select()
      .from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, s.id));
    const poll = polled.filter((e) => e.source === "POLL");
    expect(poll.map((e) => e.code).sort()).toEqual([
      "AF",
      "OK",
      "PU",
      "SA",
      "WC",
    ]);
    expect(poll.find((e) => e.code === "SA")?.status).toBeNull();
    expect(await updateKeys(s.id)).toEqual([
      "DELIVERED",
      "IN_TRANSIT",
      "LABEL_CREATED",
      "OUT_FOR_DELIVERY",
    ]);

    // Delivered shipments are no longer polled.
    await makeStale(o.orderId);
    r = await pollTracking({
      limit: 10,
      deadline: FAR(),
      adapterFor: mock(30_000),
    });
    expect(r.checked).toBe(0);
  });

  it("DHL fixtures: customs, unknown code recorded only, delivered; replay inserts nothing new", async () => {
    const o = await paidShipmentOrder({ country: "US" });
    await execSql(
      "UPDATE shipments SET status = 'LABEL_CREATED', carrier = 'DHL', tracking_number = '1234567890' WHERE order_id = $1",
      [o.orderId],
    );
    const f = fixtureFetch([
      {
        method: "GET",
        path: /\/tracking$/,
        status: 200,
        body: dhlFixture("tracking-200"),
      },
    ]);
    const adapterFor = () =>
      createDhlCarrier({ env: carrierEnv(), fetch: f.fetch });
    await pollTracking({ limit: 10, deadline: FAR(), adapterFor });
    const s = await shipmentOf(o.orderId);
    expect(s.status).toBe("DELIVERED");
    const events = await db
      .select()
      .from(shipmentEvents)
      .where(eq(shipmentEvents.shipmentId, s.id));
    expect(events).toHaveLength(8);
    expect(events.find((e) => e.code === "ZZ")?.status).toBeNull();
    expect(await updateKeys(s.id)).toEqual([
      "CUSTOMS",
      "DELIVERED",
      "IN_TRANSIT",
      "OUT_FOR_DELIVERY",
    ]);
    // Replaying the same response (forced) adds no rows and no emails.
    await execSql(
      "UPDATE shipments SET status = 'OUT_FOR_DELIVERY', last_tracked_at = NULL WHERE id = $1",
      [s.id],
    );
    await pollTracking({ limit: 10, deadline: FAR(), adapterFor });
    expect(
      await db
        .select()
        .from(shipmentEvents)
        .where(eq(shipmentEvents.shipmentId, s.id)),
    ).toHaveLength(8);
  });

  it("an exception and its recovery", async () => {
    const o = await paidShipmentOrder({ country: "US" });
    await execSql(
      "UPDATE shipments SET status = 'LABEL_CREATED', carrier = 'DHL', tracking_number = '1234567891' WHERE order_id = $1",
      [o.orderId],
    );
    const ev = (
      iso: string,
      code: string,
      status: NormalizedTrackingEvent["status"],
    ) => ({
      occurredAt: iso,
      code,
      description: code,
      status,
    });
    await pollTracking({
      limit: 10,
      deadline: FAR(),
      adapterFor: () =>
        stub([
          ev("2026-10-05T10:00:00.000Z", "PU", "IN_TRANSIT"),
          ev("2026-10-06T10:00:00.000Z", "NH", "EXCEPTION"),
        ]),
    });
    expect((await shipmentOf(o.orderId)).status).toBe("EXCEPTION");
    await makeStale(o.orderId);
    await pollTracking({
      limit: 10,
      deadline: FAR(),
      adapterFor: () =>
        stub([
          ev("2026-10-05T10:00:00.000Z", "PU", "IN_TRANSIT"),
          ev("2026-10-06T10:00:00.000Z", "NH", "EXCEPTION"),
          ev("2026-10-07T09:00:00.000Z", "WC", "OUT_FOR_DELIVERY"),
        ]),
    });
    expect((await shipmentOf(o.orderId)).status).toBe("OUT_FOR_DELIVERY");
  });

  it("a carrier error stamps last_tracked_at and leaves the status", async () => {
    const o = await paidShipmentOrder({ country: "US" });
    await execSql(
      "UPDATE shipments SET status = 'IN_TRANSIT', carrier = 'DHL', tracking_number = '1234567892' WHERE order_id = $1",
      [o.orderId],
    );
    const r = await pollTracking({
      limit: 10,
      deadline: FAR(),
      adapterFor: () =>
        stub(new ProviderUnavailableError("dhl", "HTTP 503", 503)),
    });
    expect(r).toMatchObject({ checked: 1, updated: 0, failed: 1 });
    const s = await shipmentOf(o.orderId);
    expect(s.status).toBe("IN_TRANSIT");
    expect(s.lastTrackedAt).not.toBeNull();
  });

  it("skips manual carriers and starts nothing past the deadline", async () => {
    const m = await paidShipmentOrder();
    await svc.recordManualTracking(
      m.orderId,
      { carrierName: "Israel Post", trackingNumber: "RR000000002IL" },
      ctx,
    );
    const d = await paidShipmentOrder({ country: "US" });
    await execSql(
      "UPDATE shipments SET status = 'IN_TRANSIT', carrier = 'DHL', tracking_number = '1234567893' WHERE order_id = $1",
      [d.orderId],
    );
    const r = await pollTracking({
      limit: 10,
      deadline: Date.now() - 1,
      adapterFor: () => stub([]),
    });
    expect(r).toMatchObject({ checked: 0, skipped: 1 });
  });
});

describe("tracking cron job", () => {
  it("runs within the cron wrapper and records the run", async () => {
    const res = await runCronJob("tracking");
    expect(res.ok).toBe(true);
    expect(res.stats).toMatchObject({ checked: 0, updated: 0 });
    const runs = await db
      .select()
      .from(cronRuns)
      .where(eq(cronRuns.job, "tracking"));
    expect(runs).toHaveLength(1);
  });
});
