import { formatDateTime } from "@/lib/format";
import { Layout } from "../Layout";
import { ButtonLink, Greeting, money, P, SignOff, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["checkout-link"];

/**
 * `checkout-link` (spec §4.5, §5.8, §5.10): the painter answered a quote, accepted or countered an
 * offer, or took a manual order; the work is reserved for the buyer until `expiresAt` at a fixed
 * price. The link opens the order page, where the buyer completes the address and consents, reads
 * the pre-contract disclosure and pays. Rendered in the buyer's locale; no advertising.
 */
export const checkoutLink: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    ctx.t("emails-commerce.checkoutLink.subject", {
      title: p.artworkTitle,
    }),
  preview: (p, ctx) =>
    ctx.t("emails-commerce.checkoutLink.preview", {
      number: p.orderNumber,
    }),
  Component: ({ props: p, ctx }) => {
    const t = (key: string, values?: Record<string, string | number>) =>
      ctx.t(`emails-commerce.checkoutLink.${key}`, values);
    return (
      <Layout
        ctx={ctx}
        preview={t("preview", { number: p.orderNumber })}
        orderUrl={p.orderUrl}
      >
        <Title>{t("title")}</Title>
        <Greeting ctx={ctx} name={p.buyerName} />
        <P>
          {t("body", {
            title: p.artworkTitle,
            number: p.orderNumber,
          })}
        </P>
        <P>{t("total", { amount: money(ctx, p.totalMinor, p.currency) })}</P>
        <P>
          {t("reserved", { date: formatDateTime(p.expiresAt, ctx.locale) })}
        </P>
        <ButtonLink href={p.payUrl}>{t("cta")}</ButtonLink>
        <P muted>{t("steps")}</P>
        <P muted>{t("contact")}</P>
        <SignOff ctx={ctx} />
      </Layout>
    );
  },
};
