import { describe, expect, it } from "vitest";
import {
  attemptMachine,
  canRequestTransition,
  canTransition,
  illegalSources,
  isAttemptFinal,
  isFinal,
  MACHINES,
  type MachineDef,
  orderMachine,
  refundMachine,
  shipmentMachine,
} from "@/server/domain/state-machines";

describe("state machines (spec §3.6)", () => {
  it("covers every enum value and only references known states", () => {
    for (const [name, m] of Object.entries(MACHINES)) {
      const def = m as MachineDef<string>;
      expect(Object.keys(def.edges).sort(), name).toEqual(
        [...def.states].sort(),
      );
      for (const targets of Object.values(def.edges)) {
        for (const t of targets)
          expect(def.states, `${name} → ${t}`).toContain(t);
      }
    }
  });

  it("orders", () => {
    expect(canTransition("order", "AWAITING_PAYMENT", "PAID")).toBe(true);
    expect(canTransition("order", "EXPIRED", "PAID")).toBe(true);
    expect(canTransition("order", "COMPLETED", "CANCELLED")).toBe(true);
    expect(canTransition("order", "PAID", "AWAITING_PAYMENT")).toBe(false);
    expect(canTransition("order", "CANCELLED", "PAID")).toBe(false);
    expect(orderMachine.final).toEqual(["CANCELLED"]);
  });

  it("payment attempts", () => {
    expect(canTransition("attempt", "CAPTURING", "CAPTURING")).toBe(true);
    expect(canTransition("attempt", "EXPIRED", "CAPTURING")).toBe(true);
    expect(canTransition("attempt", "EXPIRED", "SUCCEEDED")).toBe(true);
    expect(canTransition("attempt", "PENDING", "NEEDS_REFUND")).toBe(true);
    expect(canTransition("attempt", "PENDING", "REFUNDED")).toBe(true);
    expect(canTransition("attempt", "NEEDS_REFUND", "REFUNDED")).toBe(true);
    expect(canTransition("attempt", "NEEDS_REFUND", "SUCCEEDED")).toBe(false);
    expect(canTransition("attempt", "SUCCEEDED", "REFUNDED")).toBe(false);
    expect(canTransition("attempt", "FAILED", "SUCCEEDED")).toBe(false);
    expect(canTransition("attempt", "CREATED", "CAPTURING")).toBe(false);
    expect([...attemptMachine.final].sort()).toEqual(
      ["CANCELED", "FAILED", "REFUNDED", "SUCCEEDED"].sort(),
    );
    expect(isAttemptFinal("EXPIRED")).toBe(false);
  });

  it("refunds", () => {
    expect(canTransition("refund", "REQUESTED", "IN_FLIGHT")).toBe(true);
    expect(canTransition("refund", "REQUESTED", "SUCCEEDED")).toBe(false);
    expect(canTransition("refund", "IN_FLIGHT", "UNKNOWN")).toBe(true);
    expect(canTransition("refund", "UNKNOWN", "IN_FLIGHT")).toBe(false);
    expect(canTransition("refund", "FAILED", "REQUESTED")).toBe(true);
    expect(canTransition("refund", "MANUAL_REQUIRED", "MANUAL_DONE")).toBe(
      true,
    );
    expect(refundMachine.final).toEqual(["SUCCEEDED", "MANUAL_DONE"]);
  });

  it("tax documents, cancellations and outbox jobs", () => {
    expect(canTransition("taxDocument", "UNKNOWN", "ISSUING")).toBe(true);
    expect(canTransition("taxDocument", "ISSUED", "ISSUING")).toBe(false);
    expect(canTransition("cancellation", "ACCEPTED", "CLOSED")).toBe(true);
    expect(canTransition("cancellation", "REJECTED", "ACCEPTED")).toBe(false);
    expect(canTransition("outboxJob", "RUNNING", "RUNNING")).toBe(true);
    expect(canTransition("outboxJob", "DONE", "PENDING")).toBe(false);
    expect(isFinal("outboxJob", "DEAD")).toBe(true);
  });

  it("shipments: carrier path, claim protocol, pickup and cancellation", () => {
    expect(canTransition("shipment", "LABEL_REQUESTED", "LABEL_UNKNOWN")).toBe(
      true,
    );
    expect(canTransition("shipment", "LABEL_UNKNOWN", "LABEL_REQUESTED")).toBe(
      true,
    );
    expect(canTransition("shipment", "LABEL_REQUESTED", "CANCELLED")).toBe(
      false,
    );
    expect(canTransition("shipment", "LABEL_CREATED", "DELIVERED")).toBe(true);
    expect(canTransition("shipment", "OUT_FOR_DELIVERY", "IN_TRANSIT")).toBe(
      false,
    );
    expect(canTransition("shipment", "EXCEPTION", "RETURNED")).toBe(true);
    expect(canTransition("shipment", "IN_TRANSIT", "CANCELLED")).toBe(false);
    expect(canTransition("shipment", "READY_FOR_PICKUP", "COLLECTED")).toBe(
      true,
    );
    expect(canTransition("shipment", "PACKED", "OUT_FOR_DELIVERY")).toBe(true);
    expect([...shipmentMachine.final].sort()).toEqual(
      ["CANCELLED", "COLLECTED", "DELIVERED", "RETURNED"].sort(),
    );
  });

  it("buyer requests per kind", () => {
    expect(canRequestTransition("QUESTION", "NEW", "REPLIED")).toBe(true);
    expect(canRequestTransition("QUESTION", "NEW", "QUOTED")).toBe(false);
    expect(canRequestTransition("QUOTE", "QUOTED", "CONVERTED")).toBe(true);
    expect(canRequestTransition("OFFER", "NEW", "AUTO_DECLINED")).toBe(true);
    expect(canTransition("buyerRequest", "NEW", "CONVERTED")).toBe(false);
  });

  it("reports illegal sources", () => {
    expect(
      illegalSources("order", ["AWAITING_PAYMENT", "PAID"], "PAYMENT_REVIEW"),
    ).toEqual(["PAID"]);
    expect(canTransition("artwork", "SOLD", "AVAILABLE")).toBe(true);
    expect(canTransition("artwork", "NOT_FOR_SALE", "SOLD")).toBe(false);
  });
});
