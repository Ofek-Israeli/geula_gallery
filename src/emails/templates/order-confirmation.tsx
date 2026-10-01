import { Link } from "react-email";
import { formatDateTime } from "@/lib/format";
import { Layout } from "../Layout";
import { AmountTable, Greeting, P, SignOff, Subtitle, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["order-confirmation"];

/**
 * `order-confirmation` (spec §4.5, §5.4): the order summary plus the **inline disclosure summary**
 * and a link to the full disclosure document (HTML). Rendered in the buyer's locale. Sending it sets
 * `orders.disclosure_sent_at` (the SEND_EMAIL handler, which also attaches the disclosure PDF when
 * it renders — Tier B). The email also links the cancellation form with the order number prefilled
 * (spec §5.7 step 1: "in every buyer email"). Final wording is for the lawyer.
 */
export const orderConfirmation: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    ctx.t("emails-compliance.orderConfirmation.subject", {
      number: p.orderNumber,
    }),
  preview: (p, ctx) =>
    ctx.t("emails-compliance.orderConfirmation.preview", {
      number: p.orderNumber,
    }),
  Component: ({ props: p, ctx }) => {
    const t = (key: string, values?: Record<string, string | number>) =>
      ctx.t(`emails-compliance.orderConfirmation.${key}`, values);
    return (
      <Layout
        ctx={ctx}
        preview={t("preview", { number: p.orderNumber })}
        orderUrl={p.orderUrl}
      >
        <Title>{t("title")}</Title>
        <Greeting ctx={ctx} name={p.buyerName} />
        <P>{t("intro", { number: p.orderNumber })}</P>
        <P muted>
          {t("paidAt", { date: formatDateTime(p.paidAt, ctx.locale) })}
        </P>
        <Subtitle>{t("summaryTitle")}</Subtitle>
        <AmountTable
          ctx={ctx}
          currency={p.currency}
          rows={[
            ...p.items,
            ...(p.shippingMinor > 0
              ? [{ title: t("shipping"), amountMinor: p.shippingMinor }]
              : []),
            ...(p.insuranceMinor > 0
              ? [{ title: t("insurance"), amountMinor: p.insuranceMinor }]
              : []),
            { title: t("total"), amountMinor: p.totalMinor, strong: true },
          ]}
        />
        <Subtitle>{t("disclosureTitle")}</Subtitle>
        <div data-testid="disclosure-summary">
          {p.disclosure.summary.map((line) => (
            <P key={line}>{line}</P>
          ))}
        </div>
        <P>
          <Link href={p.disclosureUrl} style={{ color: "#1a1a1a" }}>
            {t("disclosureLink")}
          </Link>
        </P>
        <P muted>{t("disclosureNote")}</P>
        <P>
          <Link
            href={`${ctx.brand.cancelUrl}?order=${encodeURIComponent(p.orderNumber)}`}
            style={{ color: "#1a1a1a" }}
          >
            {t("cancelLink")}
          </Link>
        </P>
        <SignOff ctx={ctx} />
      </Layout>
    );
  },
};
