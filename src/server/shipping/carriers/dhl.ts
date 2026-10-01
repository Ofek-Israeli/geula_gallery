import "server-only";
import { notConfigured } from "@/server/payments/providers/stub";
import type { CarrierAdapter, CarrierFactoryInput } from "../types";

/**
 * DHL Express MyDHL (spec §4.4 "DHL"): Basic auth plus a stored `Message-Reference` on every call;
 * `POST /shipments` (product P, DAP, export declaration, II when insured, WY only with paperless
 * trade), tracking, pickups. No idempotency key and no cancel: labels use the LABEL_UNKNOWN
 * protocol. M1 typed stub; WS3 implements with `@/server/integrations/generated/dhl-mydhl`.
 */
export const DHL_BASES = {
  test: "https://express.api.dhl.com/mydhlapi/test",
  live: "https://express.api.dhl.com/mydhlapi",
  mock: "https://api-mock.dhl.com/mydhlapi",
} as const;

export function dhlTrackingUrl(waybill: string, locale: "he" | "en"): string {
  const region = locale === "he" ? "il-he" : "il-en";
  return `https://www.dhl.com/${region}/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(waybill)}`;
}

export function createDhlCarrier({ env }: CarrierFactoryInput): CarrierAdapter {
  return {
    id: "dhl",
    mode: env.DHL_EXPRESS_MODE === "live" ? "live" : "test",
    capabilities: {
      rates: false,
      labels: true,
      pickup: true,
      tracking: true,
      landedCost: false,
      paperlessTrade: env.DHL_PAPERLESS_TRADE,
      insurance: true,
    },
    createShipment: async () => notConfigured("dhl", "createShipment"),
    requestPickup: async () => notConfigured("dhl", "requestPickup"),
    cancelPickup: async () => notConfigured("dhl", "cancelPickup"),
    track: async () => notConfigured("dhl", "track"),
    trackingUrl: dhlTrackingUrl,
  };
}
