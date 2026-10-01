import { Link } from "react-email";
import { formatDate } from "@/lib/format";
import { Layout } from "../Layout";
import { Greeting, P, SignOff, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["shipment-update"];

/** Statuses with their own wording; anything else reads as a generic update. */
const WORDED = new Set([
  "LABEL_CREATED",
  "IN_TRANSIT",
  "CUSTOMS",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "EXCEPTION",
  "RETURNED",
  "COLLECTED",
]);

const key = (p: Props) => (WORDED.has(p.status) ? p.status : "OTHER");

/**
 * `shipment-update` (spec §4.5, §5.5 step 4): one email per new shipment status, in the buyer's
 * locale: what happened, the carrier and tracking number (with the link when there is one), the
 * estimate, and the DHL attribution for DHL tracking data (spec §5.6).
 */
export const shipmentUpdate: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    ctx.t("emails-shipping.update.subject", { number: p.orderNumber }),
  preview: (p, ctx) => ctx.t(`emails-shipping.update.title.${key(p)}` as never),
  Component: ({ props: p, ctx }) => (
    <Layout
      ctx={ctx}
      preview={ctx.t(`emails-shipping.update.title.${key(p)}` as never)}
      orderUrl={p.orderUrl}
    >
      <Title>{ctx.t(`emails-shipping.update.title.${key(p)}` as never)}</Title>
      <Greeting ctx={ctx} name={p.buyerName} />
      <P>
        {ctx.t(`emails-shipping.update.body.${key(p)}` as never, {
          number: p.orderNumber,
        })}
      </P>
      {p.carrierName && p.status !== "COLLECTED" ? (
        <P>
          {ctx.t("emails-shipping.update.carrier", { carrier: p.carrierName })}
        </P>
      ) : null}
      {p.trackingNumber ? (
        <P>
          {ctx.t("emails-shipping.update.tracking", { number: "" })}
          <span dir="ltr">{p.trackingNumber}</span>
        </P>
      ) : null}
      {p.trackingUrl ? (
        <P>
          <Link href={p.trackingUrl} style={{ color: "#1a1a1a" }}>
            {ctx.t("emails-shipping.update.track")}
          </Link>
        </P>
      ) : null}
      {p.estimatedDeliveryAt ? (
        <P>
          {ctx.t("emails-shipping.update.estimate", {
            date: formatDate(p.estimatedDeliveryAt, ctx.locale),
          })}
        </P>
      ) : null}
      {p.dhlAttribution ? (
        <P muted>{ctx.t("emails-shipping.update.dhl")}</P>
      ) : null}
      <P muted>{ctx.t("emails-shipping.update.orderPage")}</P>
      <SignOff ctx={ctx} />
    </Layout>
  ),
};
