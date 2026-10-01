import "server-only";
import { ProviderInvalidResponseError } from "@/server/integrations/http";
import type {
  CarrierAdapter,
  CarrierFactoryInput,
  NormalizedTrackingEvent,
} from "../types";
import { deliveredAtOf, dhlStatusForCode } from "./dhl-map";
import { minimalPdf } from "./minimal-pdf";

/**
 * Mock carrier (spec §4.4): waybill `MOCK` + 10 digits, a hand-written ASCII PDF label
 * (`minimal-pdf.ts`), and a deterministic timeline scaled by `MOCK_CARRIER_DELIVERY_SECONDS`.
 *
 * Stateless: the 10 digits are the label time in deciseconds since 2026-01-01 UTC (bumped within a
 * process when two labels fall in the same 100 ms, so they never share a waybill), and `track()` derives the timeline from it with
 * DHL checkpoint codes (it simulates DHL, including insurance):
 *
 * | at (× delivery seconds) | code | status |
 * |---|---|---|
 * | 0.2 | PU | IN_TRANSIT |
 * | 0.4 | AF | IN_TRANSIT |
 * | 0.5 | SA | – (informational: recorded, status unchanged) |
 * | 0.7 | WC | OUT_FOR_DELIVERY |
 * | 1.0 | OK | DELIVERED |
 */
export const MOCK_WAYBILL = /^MOCK(\d{10})$/;
const EPOCH_MS = Date.UTC(2026, 0, 1);
let lastIssued = 0;

export function mockWaybill(at: Date): string {
  let ds = Math.max(0, Math.floor((at.getTime() - EPOCH_MS) / 100));
  // Two labels in the same 100 ms get consecutive numbers; a clock far behind (tests) does not.
  if (ds <= lastIssued && lastIssued - ds < 600) ds = lastIssued + 1;
  lastIssued = ds;
  return `MOCK${String(ds).padStart(10, "0")}`;
}

export function mockWaybillTime(waybill: string): Date | null {
  const m = MOCK_WAYBILL.exec(waybill);
  return m ? new Date(EPOCH_MS + Number(m[1]) * 100) : null;
}

export const MOCK_TIMELINE = [
  { at: 0.2, code: "PU", description: "Shipment picked up" },
  { at: 0.4, code: "AF", description: "Arrived at facility" },
  { at: 0.5, code: "SA", description: "Shipment acknowledged" },
  { at: 0.7, code: "WC", description: "With delivery courier" },
  { at: 1.0, code: "OK", description: "Delivered" },
] as const;

export function createMockCarrier({
  env,
  now = () => new Date(),
}: CarrierFactoryInput): CarrierAdapter {
  const seconds = Math.max(1, env.MOCK_CARRIER_DELIVERY_SECONDS);
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

    async createShipment(r, ctx) {
      const waybill = mockWaybill(now());
      const kg = r.packages.reduce((s, p) => s + p.weightG, 0) / 1000;
      const labelPdf = minimalPdf([
        "MOCK CARRIER - NOT A REAL LABEL",
        `Waybill: ${waybill}`,
        `Order: ${r.orderNumber}`,
        `Ship date: ${r.plannedShippingDate}`,
        `To: ${r.recipient.name}`,
        `${r.recipient.address.city}, ${r.recipient.address.country}`,
        `Pieces: ${r.packages.length}  Weight: ${kg.toFixed(2)} kg`,
        `Declared: ${(r.declaredValueMinor / 100).toFixed(2)} ${r.declaredCurrency}`,
        `Incoterm: ${r.incoterm}  Invoice: ${r.invoiceNumber}`,
        r.insuredValueMinor
          ? `Insured: ${(r.insuredValueMinor / 100).toFixed(2)} ${r.declaredCurrency}`
          : "Uninsured",
        `Ref: ${ctx.messageReference}`,
      ]);
      return {
        waybill,
        trackingUrl: "",
        labelPdf,
        providerShipmentId: waybill,
        rawRedacted: {
          mock: true,
          waybill,
          pieces: r.packages.length,
          idempotencyKey: ctx.idempotencyKey,
        },
      };
    },

    async track(waybill) {
      const t0 = mockWaybillTime(waybill);
      if (!t0) {
        throw new ProviderInvalidResponseError(
          "mock",
          `not a mock waybill: ${waybill}`,
        );
      }
      const nowMs = now().getTime();
      const events: NormalizedTrackingEvent[] = MOCK_TIMELINE.map((s) => ({
        occurredAt: new Date(
          t0.getTime() + Math.round(s.at * seconds * 1000),
        ).toISOString(),
        code: s.code,
        description: s.description,
        location: "MOCK HUB",
        status: dhlStatusForCode(s.code),
      })).filter((e) => new Date(e.occurredAt).getTime() <= nowMs);
      const deliveredAt = deliveredAtOf(events);
      return { events, ...(deliveredAt ? { deliveredAt } : {}) };
    },

    // The mock timeline is shown on the order page; there is no external tracking page.
    trackingUrl: () => "",
  };
}
