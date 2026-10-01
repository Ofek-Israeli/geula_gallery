"use server";

import { z } from "zod";
import { fromJerusalemWallClock } from "@/lib/format";
import { fromDecimal } from "@/lib/money";
import {
  DomainError,
  IllegalTransitionError,
  NotFoundError,
} from "@/server/domain/errors";
import { ActionFailure, adminAction } from "@/server/next/actions";
import {
  addManualEvent,
  MANUAL_EVENT_STATUSES,
  markArtistDelivered,
  markCollected,
  markHandedOver,
  markLabelRequestUnknown,
  markReadyForPickup,
  overrideCancellationBlock,
  recordManualTracking,
  requestLabel,
  resolveUnknownLabel,
  saveCustoms,
  savePacking,
  startArtistDelivery,
} from "@/server/shipping/shipments";

/**
 * Fulfillment actions (spec §5.5). Every export is wrapped by `adminAction` (session, 2FA, locale,
 * zod), enforced by the architecture test. Domain refusals become typed `ActionFailure` codes that
 * the screen translates (`shipping.errors.*`).
 */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      throw new ActionFailure("ILLEGAL_TRANSITION");
    }
    if (error instanceof NotFoundError) throw new ActionFailure("NOT_FOUND");
    if (error instanceof DomainError) throw new ActionFailure(error.code);
    throw error;
  }
}

const orderId = z.uuid();
const list = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));
const ints = list.transform((v, c) => {
  const out = v.map((s) => Number(s.trim()));
  if (out.some((n) => !Number.isInteger(n) || n <= 0 || n > 10_000_000)) {
    c.addIssue({ code: "custom", message: "positive whole number" });
    return z.NEVER;
  }
  return out;
});
const checkbox = z
  .literal("on")
  .optional()
  .transform((v) => v === "on");
const money = z
  .string()
  .trim()
  .transform((v, c) => {
    try {
      return fromDecimal(v || "0");
    } catch {
      c.addIssue({ code: "custom", message: "amount" });
      return z.NEVER;
    }
  });

export const overrideAction = adminAction(
  z.object({ orderId, reason: z.string().trim().min(5).max(500) }),
  (i, ctx) => run(() => overrideCancellationBlock(i.orderId, i.reason, ctx)),
  { name: "fulfill.override" },
);

export const packAction = adminAction(
  z.object({
    orderId,
    checklist: list,
    lengthMm: ints,
    widthMm: ints,
    heightMm: ints,
    weightG: ints,
    photoKeys: list,
  }),
  (i, ctx) =>
    run(() =>
      savePacking(
        i.orderId,
        {
          checklist: i.checklist,
          photoKeys: i.photoKeys,
          packages: i.lengthMm.map((lengthMm, n) => ({
            lengthMm,
            widthMm: i.widthMm[n] ?? 0,
            heightMm: i.heightMm[n] ?? 0,
            weightG: i.weightG[n] ?? 0,
          })),
        },
        ctx,
      ),
    ),
  { name: "fulfill.pack" },
);

export const customsAction = adminAction(
  z.object({
    orderId,
    hsCode: z.string().trim().min(4).max(16),
    contentsDescriptionEn: z.string().trim().min(3).max(500),
    declaredValue: money,
    insuredValue: money,
    exportDecl: z.enum(["", "RECORDED", "PENDING_CARRIER"]).default(""),
    exportNumber: z.string().trim().max(40).default(""),
  }),
  (i, ctx) =>
    run(() =>
      saveCustoms(
        i.orderId,
        {
          hsCode: i.hsCode,
          contentsDescriptionEn: i.contentsDescriptionEn,
          declaredValueMinor: i.declaredValue,
          insuredValueMinor: i.insuredValue,
          ...(i.exportDecl === "RECORDED"
            ? {
                exportDeclaration: {
                  status: "RECORDED" as const,
                  number: i.exportNumber,
                },
              }
            : i.exportDecl === "PENDING_CARRIER"
              ? { exportDeclaration: { status: "PENDING_CARRIER" as const } }
              : {}),
        },
        ctx,
      ),
    ),
  { name: "fulfill.customs" },
);

export const labelAction = adminAction(
  z.object({ orderId, shipmentId: z.uuid() }),
  (i, ctx) => run(() => requestLabel(i.shipmentId, ctx)),
  { name: "fulfill.label" },
);

export const unknownLabelAction = adminAction(
  z.object({
    orderId,
    outcome: z.enum(["none", "found"]),
    waybill: z.string().trim().max(40).default(""),
  }),
  (i, ctx) =>
    run(() =>
      resolveUnknownLabel(
        i.orderId,
        i.outcome === "found"
          ? { outcome: "found", waybill: i.waybill }
          : { outcome: "none" },
        ctx,
      ),
    ),
  { name: "fulfill.label_unknown" },
);

export const staleLabelAction = adminAction(
  z.object({ orderId }),
  (i, ctx) => run(() => markLabelRequestUnknown(i.orderId, ctx)),
  { name: "fulfill.label_stale" },
);

export const trackingAction = adminAction(
  z.object({
    orderId,
    carrierName: z.string().trim().min(1).max(80),
    trackingNumber: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z0-9 -]+$/),
    trackingUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
    handedOver: checkbox,
  }),
  (i, ctx) =>
    run(() =>
      recordManualTracking(
        i.orderId,
        {
          carrierName: i.carrierName,
          trackingNumber: i.trackingNumber,
          trackingUrl: i.trackingUrl || null,
          handedOver: i.handedOver,
        },
        ctx,
      ),
    ),
  { name: "fulfill.tracking" },
);

export const handedOverAction = adminAction(
  z.object({ orderId }),
  (i, ctx) => run(() => markHandedOver(i.orderId, ctx)),
  { name: "fulfill.handed_over" },
);

export const eventAction = adminAction(
  z.object({
    orderId,
    status: z.enum(["", ...MANUAL_EVENT_STATUSES]).default(""),
    occurredAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .transform((v) => {
        const [d = "", t = ""] = v.split("T");
        const [year, month, day] = d.split("-").map(Number);
        const [hour, minute] = t.split(":").map(Number);
        return fromJerusalemWallClock({
          year: year as number,
          month: month as number,
          day: day as number,
          hour: hour as number,
          minute: minute as number,
          second: 0,
        });
      }),
    description: z.string().trim().min(1).max(300),
    location: z.string().trim().max(120).default(""),
  }),
  (i, ctx) =>
    run(() =>
      addManualEvent(
        i.orderId,
        {
          status: i.status === "" ? null : i.status,
          occurredAt: i.occurredAt,
          description: i.description,
          location: i.location || null,
        },
        ctx,
      ),
    ),
  { name: "fulfill.event" },
);

export const readyForPickupAction = adminAction(
  z.object({ orderId }),
  (i, ctx) => run(() => markReadyForPickup(i.orderId, ctx)),
  { name: "fulfill.ready_for_pickup" },
);

export const collectedAction = adminAction(
  z.object({ orderId, disclosureHandedOver: checkbox }),
  (i, ctx) =>
    run(() =>
      markCollected(
        i.orderId,
        { disclosureHandedOver: i.disclosureHandedOver },
        ctx,
      ),
    ),
  { name: "fulfill.collected" },
);

export const artistOutAction = adminAction(
  z.object({ orderId }),
  (i, ctx) => run(() => startArtistDelivery(i.orderId, ctx)),
  { name: "fulfill.artist_out" },
);

export const artistDeliveredAction = adminAction(
  z.object({ orderId, disclosureHandedOver: checkbox }),
  (i, ctx) =>
    run(() =>
      markArtistDelivered(
        i.orderId,
        { disclosureHandedOver: i.disclosureHandedOver },
        ctx,
      ),
    ),
  { name: "fulfill.artist_delivered" },
);
