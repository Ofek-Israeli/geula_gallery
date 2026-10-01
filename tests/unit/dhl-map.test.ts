import { describe, expect, it } from "vitest";
import { shipmentMachine } from "@/server/domain/state-machines";
import {
  DHL_CHECKPOINT_STATUS,
  deliveredAtOf,
  dhlCreateShipmentResponseSchema,
  dhlDocument,
  dhlStatusForCode,
  mapDhlTrackingEvents,
  redactDhlCreateResponse,
} from "@/server/shipping/carriers/dhl-map";
import { dhlFixture } from "../helpers/factories/shipping";

/** Spec §10.1 `dhl-map`: tracking codes → status (unknown codes never change it), parsing. */
describe("DHL checkpoint map", () => {
  it("maps the common codes onto shipment states", () => {
    expect(dhlStatusForCode("PU")).toBe("IN_TRANSIT");
    expect(dhlStatusForCode("cr")).toBe("CUSTOMS");
    expect(dhlStatusForCode("WC")).toBe("OUT_FOR_DELIVERY");
    expect(dhlStatusForCode("OK")).toBe("DELIVERED");
    expect(dhlStatusForCode("NH")).toBe("EXCEPTION");
    expect(dhlStatusForCode("RT")).toBe("RETURNED");
  });

  it("returns null for unknown and informational codes", () => {
    expect(dhlStatusForCode("ZZ")).toBeNull();
    expect(dhlStatusForCode("")).toBeNull();
    expect(dhlStatusForCode("SA")).toBeNull();
  });

  it("only maps onto real shipment states", () => {
    for (const s of Object.values(DHL_CHECKPOINT_STATUS)) {
      if (s !== null) expect(shipmentMachine.states).toContain(s);
    }
  });
});

describe("mapDhlTrackingEvents", () => {
  const events = mapDhlTrackingEvents(dhlFixture("tracking-200"));

  it("sorts by time and converts each event's GMT offset", () => {
    expect(events.map((e) => e.code)).toEqual([
      "SA",
      "PU",
      "PL",
      "DF",
      "ZZ",
      "CR",
      "WC",
      "OK",
    ]);
    expect(events[0]?.occurredAt).toBe("2026-10-05T07:00:00.000Z");
    // "19:05" without seconds is accepted.
    expect(events[2]?.occurredAt).toBe("2026-10-05T16:05:00.000Z");
    // -04:00 events.
    expect(events.at(-1)?.occurredAt).toBe("2026-10-06T15:30:00.000Z");
  });

  it("records the unknown code with status null, a description and a location", () => {
    const zz = events.find((e) => e.code === "ZZ");
    expect(zz).toMatchObject({
      status: null,
      description: "Synthetic unknown checkpoint",
      location: "CINCINNATI HUB - USA",
    });
  });

  it("finds the delivery time", () => {
    expect(deliveredAtOf(events)).toBe("2026-10-06T15:30:00.000Z");
    expect(deliveredAtOf(events.slice(0, 3))).toBeUndefined();
  });

  it("rejects a response without events", () => {
    expect(() =>
      mapDhlTrackingEvents({ shipments: [{ status: "x" }] }),
    ).toThrow();
    expect(mapDhlTrackingEvents({})).toEqual([]);
  });
});

describe("create-shipment response", () => {
  const res = dhlCreateShipmentResponseSchema.parse(
    dhlFixture("create-shipment-201"),
  );

  it("extracts the waybill and the PDF documents", () => {
    expect(res.shipmentTrackingNumber).toBe("1234567890");
    const label = dhlDocument(res, "label");
    expect(Buffer.from(label ?? []).toString("latin1")).toMatch(/^%PDF-/);
    expect(dhlDocument(res, "invoice")).toBeDefined();
    expect(dhlDocument(res, "waybillDoc")).toBeUndefined();
  });

  it("keeps no documents and no customer details in the stored copy", () => {
    const kept = JSON.stringify(redactDhlCreateResponse(res));
    expect(kept).not.toContain("Test Receiver");
    expect(kept).not.toContain("New York");
    expect(kept).not.toContain("JVBERi0"); // base64 "%PDF-"
    expect(redactDhlCreateResponse(res)).toMatchObject({
      shipmentTrackingNumber: "1234567890",
      documents: [
        { typeCode: "label", imageFormat: "PDF" },
        { typeCode: "invoice", imageFormat: "PDF" },
      ],
    });
  });
});
