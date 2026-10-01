import "server-only";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { audit } from "@/server/audit";
import type { Tx } from "@/server/db/client";
import {
  artworks,
  buyerRequests,
  cancellations,
  orders,
  outboxJobs,
  paymentAttempts,
  refunds,
  shipments,
  taxDocuments,
} from "@/server/db/schema";
import { IllegalTransitionError } from "./errors";
import {
  illegalSources,
  type MachineName,
  type StateOf,
} from "./state-machines";

/**
 * `transition(tx, machine, id, allowedFrom[], to, patch, actor)` (spec §3.6, frozen contract):
 * a conditional UPDATE `WHERE id = $id AND <status> IN (allowedFrom) [AND extraWhere]` that
 * throws `IllegalTransitionError` when 0 rows match, and writes the audit row in the same
 * transaction. Edges not in the machine definition are refused before any SQL runs (programming
 * errors surface in tests, not in production data).
 *
 * The caller owns locking: take row locks in the global order (spec §2.2) *before* calling.
 */
const TABLES = {
  artwork: { table: artworks, status: artworks.saleStatus, id: artworks.id },
  order: { table: orders, status: orders.status, id: orders.id },
  attempt: {
    table: paymentAttempts,
    status: paymentAttempts.status,
    id: paymentAttempts.id,
  },
  refund: { table: refunds, status: refunds.status, id: refunds.id },
  taxDocument: {
    table: taxDocuments,
    status: taxDocuments.status,
    id: taxDocuments.id,
  },
  shipment: { table: shipments, status: shipments.status, id: shipments.id },
  cancellation: {
    table: cancellations,
    status: cancellations.status,
    id: cancellations.id,
  },
  buyerRequest: {
    table: buyerRequests,
    status: buyerRequests.status,
    id: buyerRequests.id,
  },
  outboxJob: {
    table: outboxJobs,
    status: outboxJobs.status,
    id: outboxJobs.id,
  },
} as const satisfies Record<MachineName, unknown>;

type TableOf<M extends MachineName> = (typeof TABLES)[M]["table"];
type StatusKeyOf<M extends MachineName> = M extends "artwork"
  ? "saleStatus"
  : "status";
export type RowOf<M extends MachineName> = TableOf<M>["$inferSelect"];
export type IdOf<M extends MachineName> = RowOf<M>["id"];
/** Columns a transition may set alongside the status (never the id or the status itself). */
export type TransitionPatch<M extends MachineName> = Partial<
  Omit<TableOf<M>["$inferInsert"], "id" | StatusKeyOf<M> | "createdAt">
>;

export interface TransitionOptions {
  /** Extra predicate ANDed into the UPDATE (e.g. `attempts = <claimed>`, quote binding). */
  where?: SQL;
  /** Audit verb; default `<machine>.<to lower-case>`. */
  action?: string;
  ipHash?: string | null;
  /** Skip the audit row (high-volume machines such as outbox jobs). */
  skipAudit?: boolean;
}

function statusKey(machine: MachineName): "saleStatus" | "status" {
  return machine === "artwork" ? "saleStatus" : "status";
}

export async function transition<M extends MachineName>(
  tx: Tx,
  machine: M,
  id: IdOf<M>,
  allowedFrom: readonly StateOf<M>[],
  to: StateOf<M>,
  patch: TransitionPatch<M>,
  actor: string,
  opts: TransitionOptions = {},
): Promise<RowOf<M>> {
  const illegal = illegalSources(machine, allowedFrom, to);
  if (allowedFrom.length === 0 || illegal.length > 0) {
    throw new IllegalTransitionError(
      machine,
      String(id),
      allowedFrom.length ? illegal : [],
      to,
    );
  }

  const def = TABLES[machine];
  // Drizzle cannot type a column chosen at runtime across nine tables; the public signature is
  // typed per machine, so the internal casts stay local to this function.
  const table = def.table as typeof orders;
  const idCol = def.id as unknown as typeof orders.id;
  const statusCol = def.status as unknown as typeof orders.status;

  const predicate = and(
    eq(idCol, id as string),
    inArray(
      statusCol,
      allowedFrom as unknown as (typeof orders.status.enumValues)[number][],
    ),
    opts.where,
  );

  const [before] = await tx
    .select({ status: statusCol })
    .from(table)
    .where(predicate)
    .for("update");
  if (!before) {
    throw new IllegalTransitionError(machine, String(id), allowedFrom, to);
  }

  const set = { ...patch, [statusKey(machine)]: to } as Record<string, unknown>;
  const rows = await tx
    .update(table)
    .set(set as never)
    .where(predicate)
    .returning();
  const row = rows[0];
  if (!row) {
    throw new IllegalTransitionError(machine, String(id), allowedFrom, to);
  }

  if (!opts.skipAudit) {
    await audit(
      {
        actor,
        action: opts.action ?? `${machine}.${String(to).toLowerCase()}`,
        entity: machine,
        entityId: String(id),
        before: { status: before.status },
        after: { status: to, ...patch },
        ipHash: opts.ipHash ?? null,
      },
      tx,
    );
  }
  return row as unknown as RowOf<M>;
}
