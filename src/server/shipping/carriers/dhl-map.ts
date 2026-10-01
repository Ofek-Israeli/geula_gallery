import "server-only";
import { notConfigured } from "@/server/payments/providers/stub";
import type { NormalizedTrackingEvent } from "../types";

/**
 * Pure DHL mapping (spec §4.4, §10.1 `dhl-builder`, `dhl-map`): request builders that `satisfies`
 * the generated request types, and tracking event codes → shipment status (unknown codes record an
 * event and never change the status). M1 stub; WS3 implements.
 */
export function mapDhlTrackingEvents(_raw: unknown): NormalizedTrackingEvent[] {
  return notConfigured("dhl", "mapDhlTrackingEvents");
}
