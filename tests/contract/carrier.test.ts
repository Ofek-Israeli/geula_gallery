import { describe, expect, it } from "vitest";
import {
  ProviderInvalidResponseError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "@/server/integrations/http";
import { createDhlCarrier, DHL_BASES } from "@/server/shipping/carriers/dhl";
import { createManualCarrier } from "@/server/shipping/carriers/manual";
import {
  createMockCarrier,
  mockWaybill,
  mockWaybillTime,
} from "@/server/shipping/carriers/mock";
import {
  carrierEnv,
  dhlFixture,
  fixtureFetch,
  sampleShipmentRequest,
} from "../helpers/factories/shipping";
import { carrierContractSuite } from "./carrier.suite";

/**
 * Carrier contract tests (spec §10.2 "carriers (mock, dhl)"). DHL runs offline against the
 * synthetic MyDHL 3.3.2 fixtures; `DHL_CONTRACT=1` adds a read-only call to DHL's public
 * `api-mock` server (DHL's published demo credentials; no account needed).
 */
const ctx = {
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
  messageReference: "00000000-0000-4000-8000-0000000000aa",
};

// ---------------------------------------------------------------- mock

carrierContractSuite("mock", {
  make: () =>
    createMockCarrier({
      env: carrierEnv({ MOCK_CARRIER_DELIVERY_SECONDS: 60 }),
      now: () => new Date(Date.now() + 120_000),
    }),
  trackable: async () => mockWaybill(new Date()),
});

describe("mock carrier", () => {
  it("issues MOCK + 10 digit waybills that encode the label time, never twice", () => {
    const at = new Date("2026-10-01T09:00:00.000Z");
    const a = mockWaybill(at);
    const b = mockWaybill(at);
    expect(a).toMatch(/^MOCK\d{10}$/);
    expect(b).not.toBe(a);
    expect(
      Math.abs((mockWaybillTime(a)?.getTime() ?? 0) - at.getTime()),
    ).toBeLessThan(1000);
    expect(mockWaybillTime("1234567890")).toBeNull();
  });

  it("plays a deterministic timeline scaled by MOCK_CARRIER_DELIVERY_SECONDS", async () => {
    const t0 = new Date("2026-10-02T09:00:00.000Z");
    let now = t0;
    const carrier = createMockCarrier({
      env: carrierEnv({ MOCK_CARRIER_DELIVERY_SECONDS: 100 }),
      now: () => now,
    });
    const created = await carrier.createShipment?.(
      sampleShipmentRequest(),
      ctx,
    );
    const waybill = created?.waybill ?? "";
    expect((await carrier.track?.(waybill))?.events).toEqual([]);
    now = new Date(t0.getTime() + 45_000);
    const mid = await carrier.track?.(waybill);
    expect(mid?.events.map((e) => [e.code, e.status])).toEqual([
      ["PU", "IN_TRANSIT"],
      ["AF", "IN_TRANSIT"],
    ]);
    now = new Date(t0.getTime() + 100_000);
    const done = await carrier.track?.(waybill);
    expect(done?.events.map((e) => [e.code, e.status])).toEqual([
      ["PU", "IN_TRANSIT"],
      ["AF", "IN_TRANSIT"],
      ["SA", null],
      ["WC", "OUT_FOR_DELIVERY"],
      ["OK", "DELIVERED"],
    ]);
    expect(done?.deliveredAt).toBe(done?.events.at(-1)?.occurredAt);
    await expect(carrier.track?.("1234567890")).rejects.toBeInstanceOf(
      ProviderInvalidResponseError,
    );
  });
});

// ---------------------------------------------------------------- manual

carrierContractSuite("manual", { make: () => createManualCarrier() });

// ---------------------------------------------------------------- dhl (fixtures)

function dhl(routes: Parameters<typeof fixtureFetch>[0], env = carrierEnv()) {
  const f = fixtureFetch(routes);
  return { carrier: createDhlCarrier({ env, fetch: f.fetch }), ...f };
}

const OK_ROUTES = [
  {
    method: "POST",
    path: "/shipments",
    status: 201,
    body: dhlFixture("create-shipment-201"),
  },
  {
    method: "GET",
    path: /\/tracking$/,
    status: 200,
    body: dhlFixture("tracking-200"),
  },
  {
    method: "POST",
    path: "/pickups",
    status: 201,
    body: dhlFixture("pickup-201"),
  },
  { method: "DELETE", path: /\/pickups\/[^/]+$/, status: 200 },
];

carrierContractSuite("dhl (fixtures)", {
  make: () => dhl(OK_ROUTES).carrier,
  trackable: async () => "1234567890",
  unconfigured: () =>
    createDhlCarrier({
      env: carrierEnv({ DHL_API_KEY: undefined }),
      fetch: async () => {
        throw new Error("no network expected");
      },
    }),
});

describe("dhl adapter (fixtures)", () => {
  it("sends Basic auth, x-version and the claim's Message-Reference to the test base", async () => {
    const { carrier, requests } = dhl(OK_ROUTES);
    const res = await carrier.createShipment?.(sampleShipmentRequest(), ctx);
    expect(res?.waybill).toBe("1234567890");
    expect(res?.invoicePdf).toBeDefined();
    expect(res?.trackingUrl).toContain("tracking-id=1234567890");
    const req = requests[0];
    expect(req?.url.toString()).toBe(`${DHL_BASES.test}/shipments`);
    expect(req?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("test-dhl-key:test-dhl-secret").toString("base64")}`,
    );
    expect(req?.headers.get("message-reference")).toBe(ctx.messageReference);
    expect(req?.headers.get("x-version")).toBe("3.3.2");
    expect(req?.headers.get("message-reference-date")).toBeTruthy();
    expect(req?.body).toMatchObject({
      productCode: "P",
      content: { incoterm: "DAP" },
      customerReferences: [{ typeCode: "CU", value: "GG-TEST01" }],
    });
  });

  it("uses the live base in live mode", async () => {
    const { carrier, requests } = dhl(
      OK_ROUTES,
      carrierEnv({ DHL_EXPRESS_MODE: "live" }),
    );
    expect(carrier.mode).toBe("live");
    await carrier.track?.("1234567890");
    const url = requests[0]?.url;
    expect(`${url?.origin}${url?.pathname}`).toBe(
      `${DHL_BASES.live}/shipments/1234567890/tracking`,
    );
    expect(requests[0]?.url.searchParams.get("trackingView")).toBe(
      "all-checkpoints",
    );
  });

  it("maps errors: 4xx rejected, 5xx unavailable, timeout unknown, 201 without label unknown", async () => {
    const r = sampleShipmentRequest();
    await expect(
      dhl([
        {
          method: "POST",
          path: "/shipments",
          status: 400,
          body: dhlFixture("error-400"),
        },
      ]).carrier.createShipment?.(r, ctx),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
    await expect(
      dhl([
        {
          method: "POST",
          path: "/shipments",
          status: 500,
          body: dhlFixture("error-500"),
        },
      ]).carrier.createShipment?.(r, ctx),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    const timeout = new DOMException("timed out", "TimeoutError");
    await expect(
      dhl([
        { method: "POST", path: "/shipments", status: 0, error: timeout },
      ]).carrier.createShipment?.(r, ctx),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    await expect(
      dhl([
        {
          method: "POST",
          path: "/shipments",
          status: 201,
          body: dhlFixture("create-shipment-no-label-201"),
        },
      ]).carrier.createShipment?.(r, ctx),
    ).rejects.toBeInstanceOf(ProviderInvalidResponseError);
  });

  it("treats 404 tracking as 'not scanned yet'", async () => {
    const { carrier } = dhl([
      {
        method: "GET",
        path: /\/tracking$/,
        status: 404,
        body: dhlFixture("tracking-404"),
      },
    ]);
    expect(await carrier.track?.("1234567890")).toEqual({ events: [] });
  });

  it("books and cancels pickups", async () => {
    const { carrier, requests } = dhl(OK_ROUTES);
    const r = sampleShipmentRequest();
    const booked = await carrier.requestPickup?.({
      plannedDate: "2026-10-05",
      readyByTime: "10:00",
      closeTime: "17:00",
      location: r.shipper,
      packages: r.packages,
      waybills: ["1234567890"],
    });
    expect(booked?.confirmationNumber).toBe("CBJ261005000001");
    await carrier.cancelPickup?.("CBJ261005000001");
    const del = requests.find((q) => q.method === "DELETE");
    expect(del?.url.pathname).toMatch(/\/pickups\/CBJ261005000001$/);
    expect(del?.url.searchParams.get("reason")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- live (opt-in)

const LIVE = process.env.DHL_CONTRACT === "1";

describe.skipIf(!LIVE)("dhl api-mock (DHL_CONTRACT=1, read-only)", () => {
  it("tracks a sample waybill on DHL's public mock server", async () => {
    const carrier = createDhlCarrier({
      env: carrierEnv({
        // DHL's documented demo pair for api-mock.dhl.com (public; not an account).
        DHL_API_KEY: "demo-key",
        DHL_API_SECRET: "demo-secret",
      }),
      baseUrl: DHL_BASES.mock,
    });
    const res = await carrier.track?.("1234567890");
    expect(Array.isArray(res?.events)).toBe(true);
  }, 30_000);
});
