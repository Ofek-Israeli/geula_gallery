import "server-only";
import { eq } from "drizzle-orm";
import type { Locale } from "@/lib/locale";
import { absoluteUrl, localePath, paths } from "@/lib/routes";
import type { DbOrTx } from "@/server/db/client";
import { cancellations, orders } from "@/server/db/schema";
import { buyerOrderUrls } from "@/server/documents/data";
import { NotFoundError } from "@/server/domain/errors";
import type { BuiltEmail } from "@/server/email/props";
import type { Env } from "@/server/env";
import { getSetting } from "@/server/settings";
import type { AckSnapshot } from "./service";
import { maskedFromLast3 } from "./service";

/**
 * Props builders for the compliance emails (refId = the cancellation id). Wired into
 * `server/email/props.ts#EMAIL_PROPS`. The ID number is never decrypted here: the emails show the
 * masked form only (spec §7).
 */
type Deps = { db: DbOrTx; env: Env };

async function load(db: DbOrTx, id: string) {
  const [c] = await db
    .select()
    .from(cancellations)
    .where(eq(cancellations.id, id));
  if (!c) throw new NotFoundError("cancellation", id);
  const [order] = c.orderId
    ? await db.select().from(orders).where(eq(orders.id, c.orderId))
    : [];
  return { c, order: order ?? null };
}

function masked(c: { ackSnapshot: unknown; idNumberLast3: string | null }) {
  const ack = c.ackSnapshot as Partial<AckSnapshot> | null;
  return ack?.idNumberMasked ?? maskedFromLast3(c.idNumberLast3) ?? undefined;
}

export async function cancellationAckProps(
  refId: string,
  _locale: Locale,
  { db }: Deps,
): Promise<BuiltEmail<"cancellation-ack">> {
  const { c, order } = await load(db, refId);
  const ack = c.ackSnapshot as Partial<AckSnapshot> | null;
  const idMasked = masked(c);
  const orderNumber = order?.number ?? c.orderNumberInput ?? undefined;
  return {
    locale: ack?.locale ?? order?.locale ?? "he",
    orderId: order?.id ?? null,
    props: {
      cancellationNumber: c.number,
      fullName: c.fullName,
      ...(idMasked ? { idNumberMasked: idMasked } : {}),
      ...(orderNumber ? { orderNumber } : {}),
      channel: c.channel,
      receivedAt: c.receivedAt.toISOString(),
      refundDueAt: (c.refundDueAt ?? c.receivedAt).toISOString(),
      ...(c.message ? { message: c.message } : {}),
    },
  };
}

export async function painterCancellationProps(
  refId: string,
  _locale: Locale,
  { db, env }: Deps,
): Promise<BuiltEmail<"painter-cancellation">> {
  const { c, order } = await load(db, refId);
  const idMasked = masked(c);
  return {
    locale: "he",
    orderId: order?.id ?? null,
    props: {
      cancellationNumber: c.number,
      adminCancellationUrl: absoluteUrl(
        env.APP_URL,
        localePath("he", paths.admin.cancellation(c.id)),
      ),
      fullName: c.fullName,
      ...(idMasked ? { idNumberMasked: idMasked } : {}),
      ...(order ? { orderNumber: order.number } : {}),
      channel: c.channel,
      receivedAt: c.receivedAt.toISOString(),
      refundDueAt: (c.refundDueAt ?? c.receivedAt).toISOString(),
      possibleDuplicate: c.possibleDuplicate,
    },
  };
}

export async function returnInstructionsProps(
  refId: string,
  _locale: Locale,
  { db, env }: Deps,
): Promise<BuiltEmail<"return-instructions">> {
  const { c, order } = await load(db, refId);
  if (!order) throw new NotFoundError("order for cancellation", refId);
  const profile = await getSetting("business_profile", db);
  const locale = order.locale;
  return {
    locale,
    orderId: order.id,
    props: {
      orderNumber: order.number,
      buyerName: order.buyerName ?? c.fullName,
      orderUrl: buyerOrderUrls(order, locale, env).orderUrl,
      cancellationNumber: c.number,
      returnAddress: profile.returnAddress[locale],
      refundAmountMinor: c.refundAmountMinor ?? 0,
      currency: order.currency,
    },
  };
}
