import { Layout } from "../Layout";
import { AmountTable, ButtonLink, P, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["painter-new-order"];

/**
 * `painter-new-order` (spec §4.5): tells the painter a work was paid for, with a link to the admin
 * order. Always Hebrew (painter template). No buyer PII beyond the name and country.
 */
export const painterNewOrder: EmailTemplate<Props> = {
  audience: "painter",
  subject: (p, ctx) =>
    ctx.t(
      p.isDemo
        ? "emails-commerce.painterNewOrder.subjectDemo"
        : "emails-commerce.painterNewOrder.subject",
      { number: p.orderNumber },
    ),
  preview: (p, ctx) =>
    ctx.t("emails-commerce.painterNewOrder.preview", { number: p.orderNumber }),
  Component: ({ props: p, ctx }) => {
    const t = (key: string, values?: Record<string, string | number>) =>
      ctx.t(`emails-commerce.painterNewOrder.${key}`, values);
    return (
      <Layout ctx={ctx} preview={t("preview", { number: p.orderNumber })}>
        <Title>{t("title", { number: p.orderNumber })}</Title>
        {p.isDemo ? <P muted>{t("demo")}</P> : null}
        <P>{t("buyer", { name: p.buyerName, country: p.buyerCountry })}</P>
        <AmountTable
          ctx={ctx}
          currency={p.currency}
          rows={[
            ...p.items,
            { title: t("total"), amountMinor: p.totalMinor, strong: true },
          ]}
        />
        <ButtonLink href={p.adminOrderUrl}>{t("open")}</ButtonLink>
        <P muted>{t("next")}</P>
      </Layout>
    );
  },
};
