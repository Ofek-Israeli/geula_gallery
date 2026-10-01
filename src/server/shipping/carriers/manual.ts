import "server-only";
import type { CarrierAdapter } from "../types";

/**
 * Manual carrier (spec §4.4): no label, no API. Carrier name, number and URL are entered by hand
 * and stored on the shipment; events are added manually. Complete as is.
 */
export function createManualCarrier(): CarrierAdapter {
  return {
    id: "manual",
    mode: "manual",
    capabilities: {
      rates: false,
      labels: false,
      pickup: false,
      tracking: false,
      landedCost: false,
      paperlessTrade: false,
      insurance: false,
    },
    // The tracking URL is typed in by the admin (`shipments.tracking_url`).
    trackingUrl: () => "",
  };
}
