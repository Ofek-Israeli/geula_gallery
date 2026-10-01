import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { LEGAL_VERSIONS } from "@/content/legal/versions";
import { db } from "@/server/db/client";
import { cancellations, orders } from "@/server/db/schema";
import { buildEmail } from "@/server/email/props";
import { sendEmail } from "@/server/email/send";
import type { JobHandler } from "../types";

/**
 * `SEND_EMAIL` handler (spec §5.4). Owner: WS6; M2 wires the commerce templates.
 *
 * 1. `email/props.ts` loads fresh data for the template and decides the locale (`orders.locale` for
 *    buyer emails; painter templates always render in Hebrew).
 * 2. `sendEmail` skips a key whose `email_messages` row is already SENT, so a re-run never sends a
 *    second copy (the job's dedupe key is the email's idempotency key).
 * 3. `order-confirmation` carries the inline disclosure summary and link; once it is sent,
 *    `orders.disclosure_sent_at` / `disclosure_version` are set (first send only). The disclosure
 *    PDF attachment is Tier B (WS6: `ensureDisclosurePdf`, sending without it plus a WARNING on a
 *    render failure).
 * 4. `cancellation-ack`: once sent, `cancellations.ack_sent_at` is set (first send only); the
 *    on-screen acknowledgement is stored in `ack_snapshot` when the notice is received.
 */
export const sendEmailHandler: JobHandler<"SEND_EMAIL"> = async (
  payload,
  ctx,
) => {
  const built = await buildEmail(
    payload.template,
    payload.refId,
    payload.locale,
  );
  await sendEmail({
    dedupeKey: ctx.dedupeKey,
    template: payload.template,
    to: payload.to,
    locale: built.locale,
    props: built.props,
    orderId: built.orderId,
  });
  if (payload.template === "order-confirmation" && built.orderId) {
    await db
      .update(orders)
      .set({
        disclosureSentAt: new Date(),
        disclosureVersion: LEGAL_VERSIONS.disclosure,
      })
      .where(
        and(eq(orders.id, built.orderId), isNull(orders.disclosureSentAt)),
      );
  }
  if (payload.template === "cancellation-ack") {
    await db
      .update(cancellations)
      .set({ ackSentAt: new Date() })
      .where(
        and(
          eq(cancellations.id, payload.refId),
          isNull(cancellations.ackSentAt),
        ),
      );
  }
  return { kind: "done" };
};
