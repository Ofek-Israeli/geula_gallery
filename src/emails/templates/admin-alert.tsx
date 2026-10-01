import { Layout } from "../Layout";
import { ButtonLink, P, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";
import { DetailsTable } from "./compliance-parts";

type Props = EmailTemplateProps["admin-alert"];

/** Alert kinds with a Hebrew/English description (`emails-compliance.adminAlert.kinds`). */
const KNOWN_KINDS = new Set([
  "REFUND_DUE_SOON",
  "REFUND_OVERDUE",
  "UNSHIPPED_LATE",
  "EXPORT_DECLARATION_PENDING",
  "PAYMENT_REVIEW_LONG",
  "TAX_DOCUMENT_ACTION",
  "OUTBOX_JOB_DEAD",
  "TURNOVER_CEILING",
  "RATES_UNCALIBRATED",
  "INVARIANT_VIOLATION",
  "GOLIVE_BLOCKERS",
  "CONFIG_DRIFT",
  "PAYMENT_MISMATCH",
  "PAYMENT_NEEDS_REFUND",
]);

/**
 * `admin-alert` (spec §4.5): emails the painter about a CRITICAL admin alert (the daily job sends
 * one email per alert, deduplicated by the alert id). Always Hebrew. `message` is a short,
 * PII-free summary of the alert parameters.
 */
export const adminAlert: EmailTemplate<Props> = {
  audience: "painter",
  subject: (p, ctx) =>
    ctx.t("emails-compliance.adminAlert.subject", {
      severity: ctx.t(`emails-compliance.adminAlert.severity.${p.severity}`),
      kind: KNOWN_KINDS.has(p.kind)
        ? ctx.t(`emails-compliance.adminAlert.kinds.${p.kind}`)
        : p.kind,
    }),
  preview: (p, ctx) =>
    KNOWN_KINDS.has(p.kind)
      ? ctx.t(`emails-compliance.adminAlert.kinds.${p.kind}`)
      : p.kind,
  Component: ({ props: p, ctx }) => {
    const t = (key: string) => ctx.t(`emails-compliance.adminAlert.${key}`);
    const description = KNOWN_KINDS.has(p.kind) ? t(`kinds.${p.kind}`) : p.kind;
    return (
      <Layout ctx={ctx} preview={description}>
        <Title>{t("title")}</Title>
        <P>
          <strong>
            {t(`severity.${p.severity}`)} · {description}
          </strong>
        </P>
        <DetailsTable
          ctx={ctx}
          rows={[
            { label: t("kindLabel"), value: p.kind, ltr: true },
            ...(p.message ? [{ label: t("details"), value: p.message }] : []),
          ]}
        />
        <ButtonLink href={p.adminAlertsUrl}>{t("open")}</ButtonLink>
      </Layout>
    );
  },
};
