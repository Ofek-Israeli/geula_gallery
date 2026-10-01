import { Layout } from "../Layout";
import { Greeting, money, P, SignOff, Subtitle, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["return-instructions"];

/**
 * `return-instructions` (spec §4.5, §5.7 step 7): sent when a cancellation of a shipped order is
 * accepted. The return address comes from `business_profile.returnAddress`. Who pays the return
 * shipping is a lawyer question; the text does not promise either way.
 */
export const returnInstructions: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    ctx.t("emails-compliance.returnInstructions.subject", {
      number: p.orderNumber,
    }),
  preview: (p, ctx) =>
    ctx.t("emails-compliance.returnInstructions.subject", {
      number: p.orderNumber,
    }),
  Component: ({ props: p, ctx }) => {
    const t = (key: string, values?: Record<string, string | number>) =>
      ctx.t(`emails-compliance.returnInstructions.${key}`, values);
    return (
      <Layout
        ctx={ctx}
        preview={t("subject", { number: p.orderNumber })}
        orderUrl={p.orderUrl}
      >
        <Title>{t("title")}</Title>
        <Greeting ctx={ctx} name={p.buyerName} />
        <P>
          {t("intro", {
            cancellation: p.cancellationNumber,
            number: p.orderNumber,
          })}
        </P>
        <Subtitle>{t("addressTitle")}</Subtitle>
        <P>
          <strong>{p.returnAddress}</strong>
        </P>
        {p.instructions ? <P>{p.instructions}</P> : null}
        <Subtitle>{t("packTitle")}</Subtitle>
        <P>{t("pack")}</P>
        <P>
          {t("refund", {
            amount: money(ctx, p.refundAmountMinor, p.currency),
          })}
        </P>
        <P muted>{t("contact")}</P>
        <SignOff ctx={ctx} />
      </Layout>
    );
  },
};
