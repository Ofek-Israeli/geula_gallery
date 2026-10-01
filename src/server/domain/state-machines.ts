import "server-only";
import {
  artworkSaleStatusEnum,
  attemptStatusEnum,
  cancellationStatusEnum,
  jobStatusEnum,
  orderStatusEnum,
  refundStatusEnum,
  requestStatusEnum,
  shipmentStatusEnum,
  taxdocStatusEnum,
} from "@/server/db/schema/enums";

/**
 * Every state machine of spec §3.6 as data (frozen contract, spec §9.3). `transition()` in
 * `./transition.ts` refuses any edge not listed here before it touches the DB, and the conditional
 * UPDATE then enforces the actual current state.
 *
 * Reservation holds are columns, not states: "AVAILABLE + hold" is still AVAILABLE.
 */

export type ArtworkSaleStatus =
  (typeof artworkSaleStatusEnum.enumValues)[number];
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type AttemptStatus = (typeof attemptStatusEnum.enumValues)[number];
export type RefundStatus = (typeof refundStatusEnum.enumValues)[number];
export type TaxDocumentStatus = (typeof taxdocStatusEnum.enumValues)[number];
export type ShipmentStatus = (typeof shipmentStatusEnum.enumValues)[number];
export type CancellationStatus =
  (typeof cancellationStatusEnum.enumValues)[number];
export type RequestStatus = (typeof requestStatusEnum.enumValues)[number];
export type JobStatus = (typeof jobStatusEnum.enumValues)[number];

export interface MachineDef<S extends string> {
  name: string;
  states: readonly S[];
  /** States with no outgoing edges. */
  final: readonly S[];
  /** Allowed edges, `from → [to…]`. Self-edges are listed explicitly (re-entry). */
  edges: { readonly [K in S]: readonly S[] };
}

function machine<S extends string>(
  name: string,
  states: readonly S[],
  edges: { readonly [K in S]: readonly S[] },
): MachineDef<S> {
  const final = states.filter((s) => edges[s].length === 0);
  return { name, states, final, edges };
}

// ---------------------------------------------------------------- artwork (sale_status)
export const artworkMachine = machine<ArtworkSaleStatus>(
  "artwork",
  artworkSaleStatusEnum.enumValues,
  {
    // → SOLD: finalize success (ONLINE sale) or admin offline sale.
    AVAILABLE: ["ON_HOLD", "NOT_FOR_SALE", "SOLD"],
    ON_HOLD: ["AVAILABLE", "SOLD"],
    NOT_FOR_SALE: ["AVAILABLE"],
    // Relist voids the sale; a damaged return goes to NOT_FOR_SALE.
    SOLD: ["AVAILABLE", "NOT_FOR_SALE"],
  },
);

// ---------------------------------------------------------------- order
export const orderMachine = machine<OrderStatus>(
  "order",
  orderStatusEnum.enumValues,
  {
    AWAITING_PAYMENT: ["PAID", "PAYMENT_REVIEW", "EXPIRED", "CANCELLED"],
    // Review outcome: PAID, back to AWAITING_PAYMENT (hold shortened), or LOST_RESERVATION.
    PAYMENT_REVIEW: ["PAID", "AWAITING_PAYMENT", "CANCELLED"],
    // Late success while still sellable, or LOST_RESERVATION. → AWAITING_PAYMENT only through a
    // capture claim on a still-sellable work (spec §5.2 `requires_capture` step 1), never the
    // order page (M2 decision: an EXPIRED order is not re-opened by "pay again").
    EXPIRED: ["AWAITING_PAYMENT", "PAID", "CANCELLED"],
    // CANCELLED once the refund settled (REFUND_SETTLED job); COMPLETED by the daily job.
    PAID: ["CANCELLED", "COMPLETED"],
    COMPLETED: ["CANCELLED"],
    CANCELLED: [],
  },
);

// ---------------------------------------------------------------- payment attempt
const ATTEMPT_FINAL = ["SUCCEEDED", "FAILED", "CANCELED", "REFUNDED"] as const;
/** Every non-final attempt may become SUCCEEDED, NEEDS_REFUND or (EXTERNAL) REFUNDED. */
const ATTEMPT_ANY_NON_FINAL = [
  "SUCCEEDED",
  "NEEDS_REFUND",
  "REFUNDED",
] as const;

export const attemptMachine = machine<AttemptStatus>(
  "attempt",
  attemptStatusEnum.enumValues,
  {
    CREATED: ["PENDING", "FAILED", ...ATTEMPT_ANY_NON_FINAL],
    // → PAYMENT_REVIEW without a capture: a provider that reports "under review" on a direct
    // payment (the mock's "Mark under review" button). M2 addition.
    PENDING: [
      "AWAITING_CAPTURE",
      "CAPTURING",
      "PAYMENT_REVIEW",
      "CANCELED",
      "FAILED",
      "EXPIRED",
      ...ATTEMPT_ANY_NON_FINAL,
    ],
    AWAITING_CAPTURE: [
      "CAPTURING",
      "PAYMENT_REVIEW",
      "CANCELED",
      "FAILED",
      "EXPIRED",
      ...ATTEMPT_ANY_NON_FINAL,
    ],
    // Re-entry (reconcile/admin, or last_checked_at > 60 s ago) is the CAPTURING self-edge.
    CAPTURING: [
      "CAPTURING",
      "PAYMENT_REVIEW",
      "FAILED",
      "CANCELED",
      ...ATTEMPT_ANY_NON_FINAL,
    ],
    PAYMENT_REVIEW: ["FAILED", ...ATTEMPT_ANY_NON_FINAL],
    // EXPIRED is not final: a late approval can still be captured, a late success applied.
    // M2 additions: → CANCELED when a late capture claim finds the work gone or the quote stale
    // (nothing captured); → PAYMENT_REVIEW for a late "under review" report.
    EXPIRED: [
      "CAPTURING",
      "CANCELED",
      "PAYMENT_REVIEW",
      ...ATTEMPT_ANY_NON_FINAL,
    ],
    NEEDS_REFUND: ["REFUNDED"],
    SUCCEEDED: [],
    FAILED: [],
    CANCELED: [],
    REFUNDED: [],
  },
);

export function isAttemptFinal(status: AttemptStatus): boolean {
  return (ATTEMPT_FINAL as readonly string[]).includes(status);
}

/** Attempts that block pay/release/requote on their order ("payment being confirmed"). */
export const IN_FLIGHT_ATTEMPT_STATUSES = [
  "CAPTURING",
  "PAYMENT_REVIEW",
] as const satisfies readonly AttemptStatus[];

/** Attempts the reconcile job re-checks (spec §5.11). */
export const RECONCILE_ATTEMPT_STATUSES = [
  "PENDING",
  "AWAITING_CAPTURE",
  "CAPTURING",
  "PAYMENT_REVIEW",
] as const satisfies readonly AttemptStatus[];

// ---------------------------------------------------------------- refund
export const refundMachine = machine<RefundStatus>(
  "refund",
  refundStatusEnum.enumValues,
  {
    // REQUESTED → IN_FLIGHT is the claim. Offline payments go straight to MANUAL_REQUIRED.
    REQUESTED: ["IN_FLIGHT", "MANUAL_REQUIRED"],
    IN_FLIGHT: [
      "SUCCEEDED",
      "PROVIDER_PENDING",
      "FAILED",
      "UNKNOWN",
      "MANUAL_REQUIRED",
    ],
    PROVIDER_PENDING: ["SUCCEEDED", "FAILED"],
    UNKNOWN: ["SUCCEEDED", "FAILED", "MANUAL_REQUIRED"],
    // Reference required.
    MANUAL_REQUIRED: ["MANUAL_DONE"],
    // New idem_key, only after failure_confirmed_at is set (checked by the service).
    FAILED: ["REQUESTED"],
    SUCCEEDED: [],
    MANUAL_DONE: [],
  },
);

/** Refund rows that count toward "refunded or possibly refunded" except confirmed FAILED rows. */
export const SETTLED_REFUND_STATUSES = [
  "SUCCEEDED",
  "MANUAL_DONE",
] as const satisfies readonly RefundStatus[];

// ---------------------------------------------------------------- tax document
export const taxDocumentMachine = machine<TaxDocumentStatus>(
  "taxDocument",
  taxdocStatusEnum.enumValues,
  {
    // → NEEDS_MANUAL directly for modes that cannot issue (gateway + PayPal/offline, `none`).
    ISSUING: ["ISSUED", "FAILED", "UNKNOWN", "NEEDS_MANUAL"],
    // Found by marker → ISSUED; confirmed absent → ISSUING; 3 inconclusive searches → NEEDS_MANUAL.
    UNKNOWN: ["ISSUED", "ISSUING", "NEEDS_MANUAL"],
    // Admin retry.
    FAILED: ["ISSUING"],
    // The admin records a document issued by hand.
    NEEDS_MANUAL: ["ISSUED"],
    ISSUED: [],
  },
);

// ---------------------------------------------------------------- shipment
/** Carrier-path states in order; tracking may skip forward (carriers do not report every step). */
const CARRIER_PROGRESS = [
  "LABEL_CREATED",
  "PICKUP_SCHEDULED",
  "IN_TRANSIT",
  "CUSTOMS",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const satisfies readonly ShipmentStatus[];

function forwardFrom(
  s: (typeof CARRIER_PROGRESS)[number],
): readonly ShipmentStatus[] {
  return CARRIER_PROGRESS.slice(CARRIER_PROGRESS.indexOf(s) + 1);
}

export const shipmentMachine = machine<ShipmentStatus>(
  "shipment",
  shipmentStatusEnum.enumValues,
  {
    AWAITING_FULFILLMENT: ["PACKED", "READY_FOR_PICKUP", "CANCELLED"],
    // Carrier label, manual carrier (LABEL_CREATED / IN_TRANSIT), artist delivery (OUT_FOR_DELIVERY).
    PACKED: [
      "LABEL_REQUESTED",
      "LABEL_CREATED",
      "IN_TRANSIT",
      "OUT_FOR_DELIVERY",
      "CANCELLED",
    ],
    // Claim protocol (spec §5.5): back to PACKED on a clear refusal; LABEL_UNKNOWN on a timeout.
    LABEL_REQUESTED: ["LABEL_CREATED", "PACKED", "LABEL_UNKNOWN"],
    // LABEL_REQUESTED again only after the admin confirms no label exists.
    LABEL_UNKNOWN: ["LABEL_CREATED", "LABEL_REQUESTED"],
    LABEL_CREATED: [...forwardFrom("LABEL_CREATED"), "EXCEPTION", "CANCELLED"],
    PICKUP_SCHEDULED: [
      ...forwardFrom("PICKUP_SCHEDULED"),
      "LABEL_CREATED",
      "EXCEPTION",
      "CANCELLED",
    ],
    IN_TRANSIT: [...forwardFrom("IN_TRANSIT"), "EXCEPTION"],
    CUSTOMS: [...forwardFrom("CUSTOMS"), "IN_TRANSIT", "EXCEPTION"],
    OUT_FOR_DELIVERY: ["DELIVERED", "EXCEPTION"],
    EXCEPTION: ["IN_TRANSIT", "RETURNED", "DELIVERED"],
    // Collection requires disclosure_sent_at or disclosure_handed_over_at (checked by the service).
    READY_FOR_PICKUP: ["COLLECTED", "CANCELLED"],
    DELIVERED: [],
    COLLECTED: [],
    RETURNED: [],
    CANCELLED: [],
  },
);

// ---------------------------------------------------------------- cancellation
export const cancellationMachine = machine<CancellationStatus>(
  "cancellation",
  cancellationStatusEnum.enumValues,
  {
    // RECEIVED → CLOSED only for a duplicate (decision_reason='DUPLICATE', duplicate_of_id set).
    RECEIVED: ["ACCEPTED", "REJECTED", "CLOSED"],
    ACCEPTED: ["CLOSED"],
    REJECTED: [],
    CLOSED: [],
  },
);

// ---------------------------------------------------------------- buyer request
/** Per-kind graphs (spec §3.6); the DB status column is shared, so the union is the machine. */
export const REQUEST_KIND_EDGES = {
  QUESTION: { NEW: ["REPLIED"], REPLIED: ["CLOSED"] },
  OFFER: {
    NEW: ["AUTO_DECLINED", "DECLINED", "ACCEPTED", "COUNTERED"],
    ACCEPTED: ["CONVERTED", "EXPIRED"],
    COUNTERED: ["CONVERTED", "EXPIRED"],
  },
  QUOTE: { NEW: ["QUOTED", "DECLINED"], QUOTED: ["CONVERTED", "EXPIRED"] },
} as const satisfies Record<
  "QUESTION" | "OFFER" | "QUOTE",
  Partial<Record<RequestStatus, readonly RequestStatus[]>>
>;

export const buyerRequestMachine = machine<RequestStatus>(
  "buyerRequest",
  requestStatusEnum.enumValues,
  {
    NEW: [
      "REPLIED",
      "AUTO_DECLINED",
      "DECLINED",
      "ACCEPTED",
      "COUNTERED",
      "QUOTED",
    ],
    REPLIED: ["CLOSED"],
    ACCEPTED: ["CONVERTED", "EXPIRED"],
    COUNTERED: ["CONVERTED", "EXPIRED"],
    QUOTED: ["CONVERTED", "EXPIRED"],
    AUTO_DECLINED: [],
    DECLINED: [],
    CONVERTED: [],
    EXPIRED: [],
    CLOSED: [],
  },
);

export function canRequestTransition(
  kind: keyof typeof REQUEST_KIND_EDGES,
  from: RequestStatus,
  to: RequestStatus,
): boolean {
  const edges = REQUEST_KIND_EDGES[kind] as Partial<
    Record<RequestStatus, readonly RequestStatus[]>
  >;
  return edges[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------- outbox job
export const outboxJobMachine = machine<JobStatus>(
  "outboxJob",
  jobStatusEnum.enumValues,
  {
    PENDING: ["RUNNING"],
    // DONE; back to PENDING with backoff; DEAD after 8 attempts; an expired lease is re-claimed.
    RUNNING: ["DONE", "PENDING", "DEAD", "RUNNING"],
    DONE: [],
    DEAD: [],
  },
);

// ---------------------------------------------------------------- registry
export const MACHINES = {
  artwork: artworkMachine,
  order: orderMachine,
  attempt: attemptMachine,
  refund: refundMachine,
  taxDocument: taxDocumentMachine,
  shipment: shipmentMachine,
  cancellation: cancellationMachine,
  buyerRequest: buyerRequestMachine,
  outboxJob: outboxJobMachine,
} as const;

export type MachineName = keyof typeof MACHINES;
export type StateOf<M extends MachineName> =
  (typeof MACHINES)[M] extends MachineDef<infer S> ? S : never;

export function canTransition<M extends MachineName>(
  name: M,
  from: StateOf<M>,
  to: StateOf<M>,
): boolean {
  const def = MACHINES[name] as unknown as MachineDef<string>;
  return def.edges[from]?.includes(to) ?? false;
}

/** The subset of `allowedFrom` that may legally move to `to` (all of it, for valid calls). */
export function illegalSources<M extends MachineName>(
  name: M,
  allowedFrom: readonly StateOf<M>[],
  to: StateOf<M>,
): StateOf<M>[] {
  return allowedFrom.filter((from) => !canTransition(name, from, to));
}

export function isFinal<M extends MachineName>(
  name: M,
  state: StateOf<M>,
): boolean {
  const def = MACHINES[name] as unknown as MachineDef<string>;
  return def.final.includes(state);
}
