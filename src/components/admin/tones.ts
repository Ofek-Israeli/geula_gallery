import type { BadgeTone } from "@/components/ui/Badge";

/** Badge tones for admin status labels (status is always text; the tone is decoration). */
export const ARTWORK_STATUS_TONE: Record<string, BadgeTone> = {
  AVAILABLE: "available",
  ON_HOLD: "hold",
  SOLD: "sold",
  NOT_FOR_SALE: "neutral",
};

export const REFUND_STATUS_TONE: Record<string, BadgeTone> = {
  SUCCEEDED: "neutral",
  MANUAL_DONE: "neutral",
  REQUESTED: "hold",
  IN_FLIGHT: "hold",
  PROVIDER_PENDING: "hold",
  UNKNOWN: "danger",
  FAILED: "danger",
  MANUAL_REQUIRED: "danger",
};

export const ORDER_STATUS_TONE: Record<string, BadgeTone> = {
  AWAITING_PAYMENT: "hold",
  PAYMENT_REVIEW: "hold",
  PAID: "sold",
  COMPLETED: "sold",
  EXPIRED: "neutral",
  CANCELLED: "neutral",
};
