import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { paths } from "@/server/integrations/generated/dhl-mydhl";
import {
  createTypedClient,
  expectData,
  ProviderInvalidResponseError,
  ProviderNotConfiguredError,
} from "@/server/integrations/http";
import type { CarrierAdapter, CarrierFactoryInput } from "../types";
import {
  buildDhlPickupRequest,
  buildDhlShipmentRequest,
  DHL_API_VERSION,
  deliveredAtOf,
  dhlCreateShipmentResponseSchema,
  dhlDocument,
  dhlPickupResponseSchema,
  dhlPlannedShippingDateAndTime,
  mapDhlTrackingEvents,
  redactDhlCreateResponse,
} from "./dhl-map";

/**
 * DHL Express MyDHL API 3.3.2 (spec §4.4 "DHL"), via openapi-fetch and the generated types:
 * - Basic auth (`DHL_API_KEY` / `DHL_API_SECRET`) plus a `Message-Reference` on every call (the
 *   label call uses the one stored on the shipment by the claim, spec §5.5);
 * - `POST /shipments` (label + commercial invoice), tracking (`trackingView=all-checkpoints`),
 *   `POST /pickups`, `DELETE /pickups/{n}`.
 * There is no idempotency key and no shipment cancel, so labels use the LABEL_UNKNOWN protocol
 * (`shipments.ts#requestLabel`). Without credentials every call throws
 * `ProviderNotConfiguredError` (no network).
 *
 * Bases verified 2026-10-01: `express.api.dhl.com/mydhlapi[/test]` answer 401 without credentials;
 * the public `api-mock.dhl.com/mydhlapi` answers canned data with DHL's published demo pair.
 */
export const DHL_BASES = {
  test: "https://express.api.dhl.com/mydhlapi/test",
  live: "https://express.api.dhl.com/mydhlapi",
  mock: "https://api-mock.dhl.com/mydhlapi",
} as const;

/** DHL wants 28–36 characters; a UUID is 36. */
export function newMessageReference(): string {
  return randomUUID();
}

export function dhlTrackingUrl(waybill: string, locale: "he" | "en"): string {
  const region = locale === "he" ? "il-he" : "il-en";
  return `https://www.dhl.com/${region}/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(waybill)}`;
}

export function createDhlCarrier({
  env,
  fetch,
  baseUrl,
}: CarrierFactoryInput): CarrierAdapter {
  const mode = env.DHL_EXPRESS_MODE === "live" ? "live" : "test";
  const configured =
    (env.DHL_EXPRESS_MODE !== "disabled" || baseUrl !== undefined) &&
    !!env.DHL_API_KEY &&
    !!env.DHL_API_SECRET &&
    !!env.DHL_ACCOUNT_NUMBER;

  const client = () => {
    if (!configured) {
      throw new ProviderNotConfiguredError(
        "dhl",
        "DHL Express is not configured (DHL_EXPRESS_MODE and credentials)",
      );
    }
    const basic = Buffer.from(
      `${env.DHL_API_KEY}:${env.DHL_API_SECRET}`,
    ).toString("base64");
    return createTypedClient<paths>({
      provider: "dhl",
      baseUrl: baseUrl ?? DHL_BASES[mode],
      fetch,
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
      },
      timeoutMs: 30_000,
    });
  };
  const account = () => env.DHL_ACCOUNT_NUMBER as string;
  const headers = (messageReference: string) => ({
    "Message-Reference": messageReference,
    "Message-Reference-Date": new Date().toUTCString(),
    "x-version": DHL_API_VERSION,
  });

  return {
    id: "dhl",
    mode,
    capabilities: {
      rates: false,
      labels: true,
      pickup: true,
      tracking: true,
      landedCost: false,
      paperlessTrade: env.DHL_PAPERLESS_TRADE,
      insurance: true,
    },

    async createShipment(r, ctx) {
      const c = client();
      const body = buildDhlShipmentRequest(r, {
        accountNumber: account(),
        plannedShippingDateAndTime: dhlPlannedShippingDateAndTime(
          r.plannedShippingDate,
        ),
      });
      const res = await c.POST("/shipments", {
        params: { header: headers(ctx.messageReference) },
        body,
      });
      const data = expectData("dhl", res, dhlCreateShipmentResponseSchema);
      const labelPdf = dhlDocument(data, "label");
      if (!labelPdf) {
        // DHL created the shipment but sent no label: the waybill exists, so this is not a
        // clear refusal. The caller records LABEL_UNKNOWN and the admin checks MyDHL.
        throw new ProviderInvalidResponseError(
          "dhl",
          `shipment ${data.shipmentTrackingNumber} has no PDF label`,
          res.response.status,
        );
      }
      const invoicePdf = dhlDocument(data, "invoice");
      return {
        waybill: data.shipmentTrackingNumber,
        trackingUrl: dhlTrackingUrl(data.shipmentTrackingNumber, "en"),
        labelPdf,
        ...(invoicePdf ? { invoicePdf } : {}),
        providerShipmentId: data.shipmentTrackingNumber,
        rawRedacted: redactDhlCreateResponse(data),
      };
    },

    async requestPickup(r) {
      const c = client();
      const res = await c.POST("/pickups", {
        params: { header: headers(newMessageReference()) },
        body: buildDhlPickupRequest(r, { accountNumber: account() }),
      });
      const data = expectData("dhl", res, dhlPickupResponseSchema);
      return {
        confirmationNumber: data.dispatchConfirmationNumbers[0] as string,
      };
    },

    async cancelPickup(confirmationNumber) {
      const c = client();
      const res = await c.DELETE("/pickups/{dispatchConfirmationNumber}", {
        params: {
          path: { dispatchConfirmationNumber: confirmationNumber },
          query: { requestorName: "Geula Gallery", reason: "not needed" },
          header: headers(newMessageReference()),
        },
      });
      const { status } = res.response;
      if (status >= 400) {
        expectData("dhl", res, dhlPickupResponseSchema); // throws the typed error
      }
    },

    async track(waybill) {
      const c = client();
      const res = await c.GET("/shipments/{shipmentTrackingNumber}/tracking", {
        params: {
          path: { shipmentTrackingNumber: waybill },
          query: {
            trackingView: "all-checkpoints",
            levelOfDetail: "all",
            requestGMTOffsetPerEvent: true,
          },
          header: headers(newMessageReference()),
        },
      });
      // Not yet scanned: DHL answers 404 until the first checkpoint.
      if (res.response.status === 404) return { events: [] };
      // The strict parse happens in `mapDhlTrackingEvents`.
      const data = expectData("dhl", res, z.unknown());
      let events: ReturnType<typeof mapDhlTrackingEvents>;
      try {
        events = mapDhlTrackingEvents(data);
      } catch {
        throw new ProviderInvalidResponseError(
          "dhl",
          "unexpected tracking response shape",
          res.response.status,
        );
      }
      const deliveredAt = deliveredAtOf(events);
      return { events, ...(deliveredAt ? { deliveredAt } : {}) };
    },

    trackingUrl: dhlTrackingUrl,
  };
}
