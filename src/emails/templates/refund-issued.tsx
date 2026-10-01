import { Link } from "react-email";
import { Layout } from "../Layout";
import { Greeting, money, P, SignOff, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["refund-issued"];

/** `refund-issued` (spec §4.5, §5.4 REFUND_SETTLED): the refund was sent back to the buyer. */
export const refundIssued: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    ctx.t("emails-commerce.refundIssued.subject", { number: p.orderNumber }),
  preview: (p, ctx) =>
    ctx.t("emails-commerce.refundIssued.subject", { number: p.orderNumber }),
  Component: ({ props: p, ctx }) => (
    <Layout
      ctx={ctx}
      preview={ctx.t("emails-commerce.refundIssued.subject", {
        number: p.orderNumber,
      })}
      orderUrl={p.orderUrl}
    >
      <Title>{ctx.t("emails-commerce.refundIssued.title")}</Title>
      <Greeting ctx={ctx} name={p.buyerName} />
      <P>
        {ctx.t("emails-commerce.refundIssued.body", {
          amount: money(ctx, p.amountMinor, p.currency),
          number: p.orderNumber,
        })}
      </P>
      <P muted>{ctx.t("emails-commerce.refundIssued.timing")}</P>
      {p.creditNoteUrl ? (
        <P>
          <Link href={p.creditNoteUrl} style={{ color: "#1a1a1a" }}>
            {ctx.t("emails-commerce.refundIssued.creditNote")}
          </Link>
        </P>
      ) : null}
      <SignOff ctx={ctx} />
    </Layout>
  ),
};
