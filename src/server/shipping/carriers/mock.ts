import "server-only";
import { notImplemented } from "@/server/domain/errors";
import type { CarrierAdapter, CarrierFactoryInput } from "../types";

/**
 * Mock carrier (spec §4.4): waybill `MOCK` + 10 digits, a hand-written ASCII PDF label
 * (`minimal-pdf.ts`), and a deterministic timeline scaled by `MOCK_CARRIER_DELIVERY_SECONDS`.
 * M1 stub (identity real); WS3 implements createShipment/track.
 */
export function createMockCarrier(_input: CarrierFactoryInput): CarrierAdapter {
  return {
    id: "mock",
    mode: "mock",
    capabilities: {
      rates: false,
      labels: true,
      pickup: false,
      tracking: true,
      landedCost: false,
      paperlessTrade: false,
      insurance: true,
    },
    createShipment: async () =>
      notImplemented("mock carrier createShipment", "WS3"),
    track: async () => notImplemented("mock carrier track", "WS3"),
    // The mock timeline is shown on the order page itself; WS3 may add a page.
    trackingUrl: () => "",
  };
}
