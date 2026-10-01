import { Layout } from "../Layout";
import { Greeting, P, SignOff, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["payment-review"];

/** `payment-review` (spec §4.5): the provider is reviewing the payment; the work stays reserved. */
export const paymentReview: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    ctx.t("emails-commerce.paymentReview.subject", { number: p.orderNumber }),
  preview: (p, ctx) =>
    ctx.t("emails-commerce.paymentReview.subject", { number: p.orderNumber }),
  Component: ({ props: p, ctx }) => (
    <Layout
      ctx={ctx}
      preview={ctx.t("emails-commerce.paymentReview.subject", {
        number: p.orderNumber,
      })}
      orderUrl={p.orderUrl}
    >
      <Title>{ctx.t("emails-commerce.paymentReview.title")}</Title>
      <Greeting ctx={ctx} name={p.buyerName} />
      <P>
        {ctx.t("emails-commerce.paymentReview.body", { number: p.orderNumber })}
      </P>
      <SignOff ctx={ctx} />
    </Layout>
  ),
};
