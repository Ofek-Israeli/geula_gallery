import { describe, expect, it } from "vitest";
import { shipmentMachine } from "@/server/domain/state-machines";
import { ProviderNotConfiguredError } from "@/server/integrations/http";
import type { CarrierAdapter } from "@/server/shipping/types";
import { sampleShipmentRequest } from "../helpers/factories/shipping";

/**
 * Shared carrier contract (spec §4.9, §10.2): every `CarrierAdapter` exposes a consistent identity
 * and capability set, a tracking URL builder, and — where its capabilities say so — label creation
 * (a PDF and a waybill) and tracking (normalised events with ISO times and real states or null).
 */
export interface CarrierSuiteOptions {
  /** A fresh adapter whose network answers success. */
  make: () => CarrierAdapter;
  /** A waybill `track()` knows (after `createShipment` for stateless carriers). */
  trackable?: (adapter: CarrierAdapter) => Promise<string>;
  /** An adapter without credentials (ProviderNotConfigured path), when applicable. */
  unconfigured?: () => CarrierAdapter;
}

export function carrierContractSuite(name: string, o: CarrierSuiteOptions) {
  describe(`carrier contract: ${name}`, () => {
    it("has a consistent identity and capabilities", () => {
      const a = o.make();
      expect(["mock", "manual", "dhl"]).toContain(a.id);
      expect(["mock", "manual", "test", "live"]).toContain(a.mode);
      for (const v of Object.values(a.capabilities)) {
        expect(typeof v).toBe("boolean");
      }
      expect(typeof a.createShipment === "function").toBe(
        a.capabilities.labels,
      );
      expect(typeof a.track === "function").toBe(a.capabilities.tracking);
      expect(typeof a.requestPickup === "function").toBe(a.capabilities.pickup);
      expect(typeof a.trackingUrl("ABC123", "he")).toBe("string");
      expect(typeof a.trackingUrl("ABC123", "en")).toBe("string");
    });

    it("creates a label: a PDF and a waybill, without buyer PII in the stored copy", async () => {
      const a = o.make();
      if (!a.capabilities.labels || !a.createShipment) return;
      const r = sampleShipmentRequest();
      const res = await a.createShipment(r, {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        messageReference: "00000000-0000-4000-8000-000000000002",
      });
      expect(res.waybill).toMatch(/^[0-9A-Z]{6,20}$/);
      expect(Buffer.from(res.labelPdf).subarray(0, 5).toString("latin1")).toBe(
        "%PDF-",
      );
      const raw = JSON.stringify(res.rawRedacted ?? {});
      expect(raw).not.toContain(r.recipient.name);
      expect(raw).not.toContain(r.recipient.address.line1);
      expect(raw).not.toContain(r.recipient.email);
    });

    it("tracks: ISO times, real states or null, oldest first", async () => {
      const a = o.make();
      if (!a.capabilities.tracking || !a.track || !o.trackable) return;
      const waybill = await o.trackable(a);
      const { events, deliveredAt } = await a.track(waybill);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(new Date(e.occurredAt).toISOString()).toBe(e.occurredAt);
        expect(typeof e.code).toBe("string");
        expect(typeof e.description).toBe("string");
        if (e.status !== null)
          expect(shipmentMachine.states).toContain(e.status);
      }
      const times = events.map((e) => e.occurredAt);
      expect([...times].sort()).toEqual(times);
      if (deliveredAt) {
        expect(events.some((e) => e.status === "DELIVERED")).toBe(true);
      }
    });

    if (o.unconfigured) {
      it("refuses every call with ProviderNotConfiguredError when unconfigured", async () => {
        const a = o.unconfigured?.() as CarrierAdapter;
        await expect(
          a.createShipment?.(sampleShipmentRequest(), {
            idempotencyKey: "k",
            messageReference: "m",
          }),
        ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
        await expect(a.track?.("1234567890")).rejects.toBeInstanceOf(
          ProviderNotConfiguredError,
        );
      });
    }
  });
}
