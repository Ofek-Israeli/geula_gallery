import "server-only";
import { env as defaultEnv, type Env } from "@/server/env";
import type { FetchLike } from "@/server/integrations/http";
import { createDhlCarrier } from "./carriers/dhl";
import { createManualCarrier } from "./carriers/manual";
import { createMockCarrier } from "./carriers/mock";
import type { CarrierAdapter, CarrierCode } from "./types";

/**
 * Carrier registry (spec §4.4): `SHIPPING_CARRIER` (mock | manual | dhl) chooses the international
 * carrier; IL always uses the manual domestic courier. WS3 owns this file.
 */
export interface CarrierDeps {
  env?: Env;
  fetch?: FetchLike;
}

export function carrierAdapter(
  code: CarrierCode,
  deps: CarrierDeps = {},
): CarrierAdapter {
  const e = deps.env ?? defaultEnv;
  switch (code) {
    case "MOCK":
      return createMockCarrier({ env: e, fetch: deps.fetch });
    case "MANUAL":
      return createManualCarrier();
    case "DHL":
      return createDhlCarrier({ env: e, fetch: deps.fetch });
  }
}

/** The carrier for CARRIER_TABLE shipments to `country`. */
export function carrierFor(
  country: string,
  deps: CarrierDeps = {},
): CarrierCode {
  const e = deps.env ?? defaultEnv;
  if (country === "IL") return "MANUAL";
  if (e.SHIPPING_CARRIER === "dhl" && e.DHL_EXPRESS_MODE !== "disabled") {
    return "DHL";
  }
  return e.SHIPPING_CARRIER === "mock" ? "MOCK" : "MANUAL";
}
