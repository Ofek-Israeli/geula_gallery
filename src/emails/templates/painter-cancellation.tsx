import { formatDateTime } from "@/lib/format";
import { Layout } from "../Layout";
import { ButtonLink, P, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";
import { DetailsTable } from "./compliance-parts";

type Props = EmailTemplateProps["painter-cancellation"];

/**
 * `painter-cancellation` (spec §4.5, §5.7 step 4): tells the painter a notice arrived, with the
 * legal refund deadline and a duplicate hint. Always Hebrew; the ID number is masked.
 */
export const painterCancellation: EmailTemplate<Props> = {
  audience: "painter",
  subject: (p, ctx) =>
    ctx.t("emails-compliance.painterCancellation.subject", {
      number: p.cancellationNumber,
    }),
  preview: (p, ctx) =>
    ctx.t("emails-compliance.painterCancellation.subject", {
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
        preview={t("painterCancellation.subject", {
          number: p.cancellationNumber,
        })}
      >
        <Title>{t("painterCancellation.title")}</Title>
        <P>
          {t("painterCancellation.intro", {
            channel: t(`channel.${p.channel}`),
            date: received,
          })}
        </P>
        <P>
          <strong>{t("painterCancellation.deadline", { date: due })}</strong>
        </P>
        {p.possibleDuplicate ? (
          <P>{t("painterCancellation.duplicate")}</P>
        ) : null}
        {p.orderNumber ? null : <P>{t("painterCancellation.unmatched")}</P>}
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
            { label: t("labels.receivedAt"), value: received },
          ]}
        />
        <ButtonLink href={p.adminCancellationUrl}>
          {t("painterCancellation.open")}
        </ButtonLink>
      </Layout>
    );
  },
};
