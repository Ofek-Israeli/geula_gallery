"use server";

import { z } from "zod";
import { fromJerusalemWallClock } from "@/lib/format";
import { fromDecimal } from "@/lib/money";
import {
  checkboxSchema,
  optionalText,
  orderNumberSchema,
} from "@/lib/validation/common";
import {
  CANCELLATION_CHANNELS,
  cancellationNoticeSchema,
} from "@/server/cancellations/notice";
import {
  acceptCancellation,
  closeAsDuplicate,
  closeCancellation,
  matchCancellationToOrder,
  recordCancellationNotice,
  recordInspection,
  recordReturnReceived,
  refundCancellation,
  rejectCancellation,
  relistAfterCancellation,
} from "@/server/cancellations/service";
import { DomainError } from "@/server/domain/errors";
import { ActionFailure, adminAction } from "@/server/next/actions";

/**
 * Admin cancellation actions (spec §5.7 steps 5–9, §6.10). Every export is wrapped by
 * `adminAction`; money-moving decisions require a fresh session (spec §7). Domain errors become
 * `ActionFailure(code)`; the page translates `cancel.admin.errors.<code>`.
 */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DomainError) throw new ActionFailure(error.code);
    throw error;
  }
}

const id = z.object({ cancellationId: z.uuid() });

/** A decimal fee typed by the admin ("75", "27.02"); blank → the suggestion. */
const feeSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      try {
        return fromDecimal(v);
      } catch {
        ctx.addIssue({ code: "custom", message: "invalid" });
        return z.NEVER;
      }
    }),
);

export const logNoticeAction = adminAction(
  z
    .object({
      channel: z.enum(CANCELLATION_CHANNELS),
      /** `datetime-local` in Asia/Jerusalem wall-clock time. */
      receivedAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/)
        .transform((v) => {
          const [d = "", tm = ""] = v.split("T");
          const [year, month, day] = d.split("-").map(Number);
          const [hour, minute, second] = tm.split(":").map(Number);
          return fromJerusalemWallClock({
            year: year ?? 0,
            month: month ?? 1,
            day: day ?? 1,
            hour: hour ?? 0,
            minute: minute ?? 0,
            second: second ?? 0,
          });
        }),
      noticeLocale: z.enum(["he", "en"]),
    })
    .and(cancellationNoticeSchema),
  async (input, ctx) =>
    run(async () => {
      if (input.receivedAt.getTime() > Date.now() + 5 * 60_000) {
        throw new ActionFailure("INVALID_INPUT");
      }
      const { channel, receivedAt, noticeLocale, ...notice } = input;
      const { result, effects } = await recordCancellationNotice(notice, {
        locale: noticeLocale,
        channel,
        receivedAt,
        actor: ctx.actor,
        ipHash: ctx.ipHash,
      });
      return {
        result: { id: result.id, number: result.ack.number },
        effects,
      };
    }),
  { name: "cancellations.log" },
);

export const matchAction = adminAction(
  id.extend({ orderNumber: orderNumberSchema }),
  async (input, ctx) =>
    run(() =>
      matchCancellationToOrder(ctx, input.cancellationId, input.orderNumber),
    ),
  { name: "cancellations.match" },
);

export const acceptAction = adminAction(
  id.extend({
    feeMinor: feeSchema,
    grantFourMonths: checkboxSchema,
    note: optionalText(500),
  }),
  async (input, ctx) =>
    run(() =>
      acceptCancellation(ctx, input.cancellationId, {
        ...(input.feeMinor !== undefined ? { feeMinor: input.feeMinor } : {}),
        grantFourMonths: input.grantFourMonths,
        ...(input.note ? { note: input.note } : {}),
      }),
    ),
  { name: "cancellations.accept", fresh: true },
);

export const rejectAction = adminAction(
  id.extend({ reason: z.string().trim().min(1).max(500) }),
  async (input, ctx) =>
    run(() => rejectCancellation(ctx, input.cancellationId, input.reason)),
  { name: "cancellations.reject" },
);

export const duplicateAction = adminAction(
  id.extend({
    duplicateOf: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^C-[0-9A-Z]{6}$/),
  }),
  async (input, ctx) =>
    run(() => closeAsDuplicate(ctx, input.cancellationId, input.duplicateOf)),
  { name: "cancellations.duplicate" },
);

export const refundAction = adminAction(
  id,
  async (input, ctx) =>
    run(() => refundCancellation(ctx, input.cancellationId)),
  { name: "cancellations.refund", fresh: true },
);

export const returnReceivedAction = adminAction(
  id.extend({ tracking: optionalText(64) }),
  async (input, ctx) =>
    run(() =>
      recordReturnReceived(ctx, input.cancellationId, {
        ...(input.tracking ? { tracking: input.tracking } : {}),
      }),
    ),
  { name: "cancellations.return" },
);

export const inspectionAction = adminAction(
  id.extend({
    result: z.enum(["ok", "damaged"]),
    notes: optionalText(1000),
  }),
  async (input, ctx) =>
    run(() =>
      recordInspection(ctx, input.cancellationId, {
        damaged: input.result === "damaged",
        ...(input.notes ? { notes: input.notes } : {}),
      }),
    ),
  { name: "cancellations.inspect" },
);

export const closeAction = adminAction(
  id,
  async (input, ctx) => run(() => closeCancellation(ctx, input.cancellationId)),
  { name: "cancellations.close" },
);

export const relistAction = adminAction(
  id,
  async (input, ctx) =>
    run(() => relistAfterCancellation(ctx, input.cancellationId)),
  { name: "cancellations.relist", fresh: true },
);
