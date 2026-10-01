import { Layout } from "../Layout";
import { Greeting, money, P, SignOff, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["purchase-not-completed"];

/**
 * `purchase-not-completed` (spec §4.5, §5.2): a payment arrived but could not complete the purchase
 * (the work was sold meanwhile, a duplicate payment, a stale quote, a cancelled order, an amount
 * mismatch), or the capture found the work gone. Says whether the buyer was charged and, if so,
 * that a full refund is on its way.
 */
export const purchaseNotCompleted: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    ctx.t("emails-commerce.notCompleted.subject", { number: p.orderNumber }),
  preview: (p, ctx) =>
    ctx.t("emails-commerce.notCompleted.subject", { number: p.orderNumber }),
  Component: ({ props: p, ctx }) => {
    const t = (key: string, values?: Record<string, string | number>) =>
      ctx.t(`emails-commerce.notCompleted.${key}`, values);
    return (
      <Layout
        ctx={ctx}
        preview={t("subject", { number: p.orderNumber })}
        orderUrl={p.orderUrl}
      >
        <Title>{t("title")}</Title>
        <Greeting ctx={ctx} name={p.buyerName} />
        <P>{t(`reason.${p.reason}`, { number: p.orderNumber })}</P>
        {p.charged ? (
          <P>
            {p.refundAmountMinor
              ? t("refundAmount", {
                  amount: money(ctx, p.refundAmountMinor, p.currency),
                })
              : t("refund")}
          </P>
        ) : (
          <P>{t("notCharged")}</P>
        )}
        <P muted>{t("contact")}</P>
        <SignOff ctx={ctx} />
      </Layout>
    );
  },
};
