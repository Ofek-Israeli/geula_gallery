import { formatDateTime } from "@/lib/format";
import { Layout } from "../Layout";
import { Greeting, P, SignOff, Subtitle, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";
import { DetailsTable } from "./compliance-parts";

type Props = EmailTemplateProps["cancellation-ack"];

/**
 * `cancellation-ack` (spec §4.5, §5.7 step 4): the emailed acknowledgement of a cancellation notice
 * with its content, date and time. The ID number is **always masked** (spec §7): the props carry
 * only `idNumberMasked`. Rendered in the buyer's locale. Final wording is for the lawyer.
 */
export const cancellationAck: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    ctx.t("emails-compliance.cancellationAck.subject", {
      number: p.cancellationNumber,
    }),
  preview: (p, ctx) =>
    ctx.t("emails-compliance.cancellationAck.subject", {
      number: p.cancellationNumber,
    }),
  Component: ({ props: p, ctx }) => {
    const t = (key: string, values?: Record<string, string | number>) =>
      ctx.t(`emails-compliance.${key}`, values);
    const received = formatDateTime(p.receivedAt, ctx.locale);
    const due = formatDateTime(p.refundDueAt, ctx.locale);
    return (
      <Layout
        ctx={ctx}
        preview={t("cancellationAck.subject", { number: p.cancellationNumber })}
      >
        <Title>{t("cancellationAck.title")}</Title>
        <Greeting ctx={ctx} name={p.fullName} />
        <P>{t("cancellationAck.intro", { date: received })}</P>
        <Subtitle>{t("cancellationAck.detailsTitle")}</Subtitle>
        <div data-testid="cancellation-ack-details">
          <DetailsTable
            ctx={ctx}
            rows={[
              {
                label: t("labels.number"),
                value: p.cancellationNumber,
                ltr: true,
              },
              { label: t("labels.fullName"), value: p.fullName },
              ...(p.idNumberMasked
                ? [
                    {
                      label: t("labels.idNumber"),
                      value: p.idNumberMasked,
                      ltr: true,
                    },
                  ]
                : []),
              ...(p.orderNumber
                ? [
                    {
                      label: t("labels.orderNumber"),
                      value: p.orderNumber,
                      ltr: true,
                    },
                  ]
                : []),
              { label: t("labels.channel"), value: t(`channel.${p.channel}`) },
              { label: t("labels.receivedAt"), value: received },
              { label: t("labels.refundDueAt"), value: due },
              ...(p.message
                ? [{ label: t("labels.message"), value: p.message }]
                : []),
            ]}
          />
        </div>
        <Subtitle>{t("cancellationAck.nextTitle")}</Subtitle>
        <P>{t("cancellationAck.next1", { date: due })}</P>
        <P>{t("cancellationAck.next2")}</P>
        <P muted>{t("cancellationAck.next3")}</P>
        <SignOff ctx={ctx} />
      </Layout>
    );
  },
};
