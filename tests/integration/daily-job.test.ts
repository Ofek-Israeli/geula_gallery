import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cleanDatabaseBeforeEach } from "../helpers/db";
import { execSql } from "../helpers/factories/commerce";
import {
  markDelivered,
  notice,
  paidTestOrder,
} from "../helpers/factories/compliance";

/**
 * The `daily` job (spec §5.11): refund-deadline alerts, COMPLETED transitions (14 days, or 4
 * months after a conversation; never with an open cancellation), invariant alerts and the
 * `admin-alert` email for CRITICAL alerts.
 */
const { db } = await import("@/server/db/client");
const schema = await import("@/server/db/schema");
const { runCronJob } = await import("@/server/jobs/index");
const { completionDue } = await import("@/server/jobs/daily");
const svc = await import("@/server/cancellations/service");
const { buildEmail } = await import("@/server/email/props");

cleanDatabaseBeforeEach();

const DAY = 86_400_000;

async function orderStatus(id: string) {
  const [o] = await db
    .select({ status: schema.orders.status })
    .from(schema.orders)
    .where(eq(schema.orders.id, id));
  return o?.status;
}

describe("daily job", () => {
  it("completes delivered orders after 14 days, after 4 months with a conversation, never with an open notice", async () => {
    const plain = await paidTestOrder();
    const talked = await paidTestOrder();
    const notified = await paidTestOrder();
    const fresh = await paidTestOrder();
    for (const p of [plain, talked, notified]) {
      await markDelivered(db, p.order.id, new Date(Date.now() - 20 * DAY));
    }
    await markDelivered(db, fresh.order.id, new Date(Date.now() - 3 * DAY));
    await execSql(
      "UPDATE orders SET conversation_took_place = true, conversation_source = 'ADMIN' WHERE id = $1",
      [talked.order.id],
    );
    const { result } = await svc.recordCancellationNotice(
      notice({
        fullName: notified.order.buyerName ?? "",
        orderNumber: notified.order.number,
      }),
      { locale: "he", actor: "anonymous" },
    );
    // A RECEIVED notice blocks fulfillment; clear the block to prove the notice itself blocks.
    await execSql(
      "UPDATE orders SET fulfillment_blocked_reason = NULL WHERE id = $1",
      [notified.order.id],
    );

    const run = await runCronJob("daily", { db });
    expect(run.ok).toBe(true);
    expect(await orderStatus(plain.order.id)).toBe("COMPLETED");
    expect(await orderStatus(talked.order.id)).toBe("PAID");
    expect(await orderStatus(notified.order.id)).toBe("PAID");
    expect(await orderStatus(fresh.order.id)).toBe("PAID");
    expect(result.id).toBeTruthy();

    // The window for a conversation order is 4 months.
    const due = completionDue({
      deliveredAt: new Date("2026-01-10T10:00:00Z"),
      disclosureSentAt: null,
      disclosureHandedOverAt: null,
      conversationTookPlace: true,
    });
    expect(due?.toISOString().slice(0, 10)).toBe("2026-05-10");
  });

  it("raises refund deadline alerts and emails the painter about CRITICAL ones", async () => {
    const p = await paidTestOrder();
    const { result } = await svc.recordCancellationNotice(
      notice({
        fullName: p.order.buyerName ?? "",
        orderNumber: p.order.number,
      }),
      {
        locale: "he",
        actor: "anonymous",
        receivedAt: new Date(Date.now() - 13 * DAY),
      },
    );
    await runCronJob("daily", { db });
    const alerts = await db.select().from(schema.adminAlerts);
    const due = alerts.find(
      (a) => a.kind === "REFUND_DUE_SOON" && a.entityId === result.id,
    );
    expect(due?.severity).toBe("CRITICAL");
    // Idempotent: a second run raises nothing new.
    await runCronJob("daily", { db });
    expect(
      (await db.select().from(schema.adminAlerts)).filter(
        (a) => a.entityId === result.id,
      ),
    ).toHaveLength(1);

    const jobs = await db.select().from(schema.outboxJobs);
    const mail = jobs.find(
      (j) =>
        (j.payload as { template?: string; refId?: string }).template ===
          "admin-alert" && (j.payload as { refId?: string }).refId === due?.id,
    );
    expect(mail).toBeTruthy();
    const built = await buildEmail("admin-alert", due?.id ?? "", "he");
    expect(built.locale).toBe("he");
    expect(built.props.kind).toBe("REFUND_DUE_SOON");
    expect(built.props.message).not.toMatch(/@/);
  });
});
