import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ActionForm, FormField } from "@/components/admin/forms";
import { ManualTrackingForm } from "@/components/admin/ManualTrackingForm";
import { RecheckButton } from "@/components/admin/RecheckButton";
import {
  ORDER_STATUS_TONE,
  REFUND_STATUS_TONE,
} from "@/components/admin/tones";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { Price } from "@/components/ui/Price";
import { Link } from "@/i18n/navigation";
import { countryName } from "@/lib/countries";
import { formatDateTime, jerusalemDateKey } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { toDecimalString } from "@/lib/money";
import { localePath, paths } from "@/lib/routes";
import { requireAdmin } from "@/server/next/guards";
import { getAdminOrder, refundableByAttempt } from "@/server/orders/admin";
import { isNonFinalAttempt } from "@/server/payments/apply";
import {
  adminRefundAction,
  cancelUnpaidOrderAction,
  confirmRefundFailedAction,
  manualTaxDocumentAction,
  manualTrackingAction,
  markRefundDoneAction,
  recheckPaymentAction,
  recheckRefundAction,
  recordPaymentAction,
  resolveUnknownRefundAction,
  retryRefundAction,
  retryTaxDocumentAction,
} from "./actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/orders/[id]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-orders.list" });
  return { title: t("title") };
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="flex flex-col gap-3 border border-line p-4"
      data-testid={testId}
    >
      <h2 className="text-xl">{title}</h2>
      {children}
    </section>
  );
}

/**
 * `/admin/orders/[id]` (spec §6.10): summary, buyer, payment attempts with "Recheck payment",
 * refunds, tax documents, shipment with minimal manual tracking, emails, alerts and the audit
 * timeline. M2 version; WS4 adds refund dialogs and record payment, WS3 the fulfillment screen.
 */
export default async function AdminOrderPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/orders/[id]">) {
  const { locale, id } = await params;
  const created = Boolean((await searchParams).created);
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const detail = await getAdminOrder(ctx, id);
  if (!detail) notFound();
  const t = await getTranslations({ locale, namespace: "admin-orders" });
  const { order } = detail;
  const when = (d: Date | null | undefined) =>
    d ? formatDateTime(d, locale) : "—";
  const money = (minor: number) => (
    <Price amountMinor={minor} currency={order.currency} locale={locale} />
  );
  const buyerUrl = localePath(
    order.locale,
    paths.order(order.number, detail.buyerToken),
  );
  const disclosureUrl = localePath(
    order.locale,
    paths.printDisclosure(order.number, detail.buyerToken),
  );
  const pickup = order.shippingMethod === "LOCAL_PICKUP";
  const address = [
    order.shipName,
    order.shipLine1,
    order.shipLine2,
    [order.shipPostalCode, order.shipCity].filter(Boolean).join(" "),
    order.shipRegion,
    countryName(order.shipCountry, locale),
  ]
    .filter(Boolean)
    .join(", ");
  const shipment = detail.shipment;
  const refundable = refundableByAttempt(detail.attempts, detail.refunds);
  const tc = await getTranslations({ locale, namespace: "admin-shell.common" });
  const err = "admin-orders.errors";
  const unpaid = order.status === "AWAITING_PAYMENT";
  const inFlight = detail.attempts.some(
    (a) => a.status === "CAPTURING" || a.status === "PAYMENT_REVIEW",
  );
  const trackingAllowed =
    order.status === "PAID" &&
    !order.fulfillmentBlockedReason &&
    shipment !== null &&
    (shipment.method === "CARRIER_TABLE" || shipment.method === "QUOTED");

  return (
    <div className="flex max-w-4xl flex-col gap-6" data-testid="admin-order">
      <Link href={paths.admin.orders()} className="text-sm">
        {t("detail.back")}
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl">
          {t("detail.title", { number: "" })}
          <bdi data-testid="admin-order-number">{order.number}</bdi>
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={ORDER_STATUS_TONE[order.status]}>
            <span data-testid="admin-order-status">
              {t(`status.${order.status}`)}
            </span>
          </Badge>
          {order.isDemo ? <Badge tone="hold">{t("detail.demo")}</Badge> : null}
          <span className="text-sm text-ink-muted">
            {t("detail.source", { source: t(`source.${order.source}`) })}
          </span>
          <span className="text-sm text-ink-muted">
            {t("detail.created", { date: when(order.createdAt) })}
          </span>
        </div>
        {order.fulfillmentBlockedReason ? (
          <p className="font-medium text-reddot">
            {t("detail.blocked", {
              reason: t(`blockedReason.${order.fulfillmentBlockedReason}`),
            })}
          </p>
        ) : null}
        <p className="flex flex-wrap gap-4 text-sm">
          <a href={buyerUrl} target="_blank" rel="noreferrer">
            {t("detail.buyerView")}
          </a>
          {order.paidAttemptId ? (
            <a href={disclosureUrl} target="_blank" rel="noreferrer">
              {t("detail.disclosure")}
            </a>
          ) : null}
        </p>
        {created ? (
          <p role="status" data-testid="order-created">
            {t("detail.orderCreated")}
          </p>
        ) : null}
      </header>

      <Section title={t("detail.summary")}>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
          {detail.items.map((i) => (
            <div key={i.id} className="contents">
              <dt>{locale === "he" ? i.titleHe : i.titleEn}</dt>
              <dd className="text-end">{money(i.priceMinor)}</dd>
            </div>
          ))}
          <dt>{t("detail.shipping")}</dt>
          <dd className="text-end">{money(order.shippingMinor)}</dd>
          {order.insuranceMinor > 0 ? (
            <>
              <dt>{t("detail.insurance")}</dt>
              <dd className="text-end">{money(order.insuranceMinor)}</dd>
            </>
          ) : null}
          <dt className="font-semibold">{t("detail.total")}</dt>
          <dd className="text-end font-semibold">{money(order.totalMinor)}</dd>
          {order.vatMinor > 0 ? (
            <>
              <dt className="text-ink-muted">{t("detail.vat")}</dt>
              <dd className="text-end text-ink-muted">
                {money(order.vatMinor)}
              </dd>
            </>
          ) : null}
        </dl>
        <p className="text-sm text-ink-muted">
          {t("detail.quoteVersion", { version: order.quoteVersion })}
        </p>
      </Section>

      <Section title={t("detail.buyer")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-ink-muted">{t("detail.name")}</dt>
          <dd>
            <bdi>{order.buyerName ?? "—"}</bdi>
          </dd>
          <dt className="text-ink-muted">{t("detail.email")}</dt>
          <dd>
            <bdi>{order.buyerEmail ?? "—"}</bdi>
          </dd>
          <dt className="text-ink-muted">{t("detail.phone")}</dt>
          <dd>
            <bdi dir="ltr">{order.buyerPhone ?? "—"}</bdi>
          </dd>
          <dt className="text-ink-muted">{t("detail.method")}</dt>
          <dd data-testid="admin-order-method">
            {order.shippingMethod ? t(`method.${order.shippingMethod}`) : "—"}
          </dd>
          {pickup ? (
            <>
              <dt className="text-ink-muted">{t("detail.country")}</dt>
              <dd>{countryName(order.shipCountry, locale)}</dd>
            </>
          ) : (
            <>
              <dt className="text-ink-muted">{t("detail.address")}</dt>
              <dd>
                <bdi>{address || "—"}</bdi>
              </dd>
            </>
          )}
          <dt className="text-ink-muted">{t("detail.receiptByEmail")}</dt>
          <dd>
            {order.receiptEmailConsent ? t("detail.yes") : t("detail.no")}
          </dd>
        </dl>
      </Section>

      <Section title={t("detail.attempts")} testId="admin-attempts">
        {detail.attempts.length === 0 ? (
          <p>{t("detail.noAttempts")}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {detail.attempts.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-1 border-b border-line pbe-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {t("detail.attempt", {
                      seq: a.seq,
                      provider: t(`provider.${a.provider}`),
                    })}
                  </span>
                  <Badge>{t(`attemptStatus.${a.status}`)}</Badge>
                  <code
                    className="text-xs text-ink-muted"
                    data-testid="attempt-status"
                  >
                    {a.status}
                  </code>
                  <span>
                    <Price
                      amountMinor={a.amountMinor}
                      currency={a.currency}
                      locale={locale}
                    />
                  </span>
                  <span className="text-sm text-ink-muted">
                    {when(a.createdAt)}
                  </span>
                </div>
                {a.providerRef ? (
                  <p className="text-sm text-ink-muted">
                    <bdi dir="ltr">{a.providerRef}</bdi>
                    {a.transactionId ? (
                      <>
                        {" · "}
                        <bdi dir="ltr">{a.transactionId}</bdi>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {a.failureReason ? (
                  <p className="text-sm text-reddot">{a.failureReason}</p>
                ) : null}
                {isNonFinalAttempt(a.status) && a.provider !== "OFFLINE" ? (
                  <>
                    {a.nextCheckAt ? (
                      <p className="text-sm text-ink-muted">
                        {t("detail.nextCheck", { date: when(a.nextCheckAt) })}
                      </p>
                    ) : null}
                    <RecheckButton
                      action={recheckPaymentAction}
                      attemptId={a.id}
                      locale={locale}
                    />
                  </>
                ) : null}
                {(refundable[a.id] ?? 0) > 0 ? (
                  <div
                    className="flex flex-wrap items-center gap-3"
                    data-testid="refund-dialog"
                  >
                    <span className="text-sm">
                      {t("detail.refundable", { amount: "" })}
                      <Price
                        amountMinor={refundable[a.id] ?? 0}
                        currency={a.currency}
                        locale={locale}
                      />
                    </span>
                    <Dialog
                      title={t("refund.title", { seq: a.seq })}
                      triggerLabel={t("refund.open")}
                      triggerSize="sm"
                    >
                      <div className="flex flex-col gap-3">
                        <p className="text-sm">{t("refund.intro")}</p>
                        <p className="text-sm text-ink-muted">
                          {t("refund.freshHint")}
                        </p>
                        <ActionForm
                          action={adminRefundAction}
                          locale={locale}
                          hidden={{ attemptId: a.id }}
                          submitLabel={t("refund.submit")}
                          submitVariant="danger"
                          successText={t("refund.done")}
                          errorNamespace={err}
                          testId="refund-form"
                        >
                          <FormField
                            name="amount"
                            label={t("refund.amount")}
                            hint={t("detail.refundable", {
                              amount: toDecimalString(refundable[a.id] ?? 0),
                            })}
                            type="number"
                            defaultValue={toDecimalString(
                              refundable[a.id] ?? 0,
                            )}
                            required
                          />
                          <FormField name="note" label={t("refund.note")} />
                        </ActionForm>
                      </div>
                    </Dialog>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {unpaid ? (
        <Section title={t("payment.title")} testId="record-payment">
          <p className="text-sm text-ink-muted">{t("payment.intro")}</p>
          <ActionForm
            action={recordPaymentAction}
            locale={locale}
            hidden={{ orderId: order.id, currency: order.currency }}
            submitLabel={t("payment.submit")}
            successText={t("payment.done")}
            errorNamespace={err}
            confirm={{
              title: t("payment.title"),
              message: t("payment.confirm"),
              confirmLabel: t("payment.submit"),
            }}
            testId="record-payment-form"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                name="method"
                label={t("payment.method")}
                type="select"
                defaultValue="transfer"
                options={(
                  [
                    "transfer",
                    "cash",
                    "cheque",
                    "bit",
                    "card",
                    "other",
                  ] as const
                ).map((m) => ({ value: m, label: t(`payment.methods.${m}`) }))}
              />
              <FormField
                name="amount"
                label={t("payment.amount")}
                hint={t("payment.amountHint", {
                  total: `${toDecimalString(order.totalMinor)} ${order.currency}`,
                })}
                type="number"
                required
              />
              <FormField
                name="reference"
                label={t("payment.reference")}
                dir="ltr"
              />
              <FormField
                name="receivedOn"
                label={t("payment.receivedOn")}
                type="date"
                defaultValue={jerusalemDateKey(new Date())}
                required
              />
            </div>
          </ActionForm>
          {!inFlight ? (
            <ActionForm
              action={cancelUnpaidOrderAction}
              locale={locale}
              hidden={{ orderId: order.id }}
              submitLabel={t("unpaid.cancel")}
              submitVariant="ghost"
              successText={t("unpaid.cancelled")}
              errorNamespace={err}
              confirm={{
                title: t("unpaid.cancel"),
                message: t("unpaid.cancelConfirm"),
                confirmLabel: t("unpaid.cancel"),
              }}
            />
          ) : null}
        </Section>
      ) : null}

      <Section title={t("detail.refunds")} testId="admin-refunds">
        {detail.refunds.length === 0 ? (
          <p>{t("detail.noRefunds")}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {detail.refunds.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-2 border-b border-line pbe-3"
                data-testid="refund-row"
                data-status={r.status}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={REFUND_STATUS_TONE[r.status]}>
                    {t(`refundStatus.${r.status}`)}
                  </Badge>
                  <span>{t(`refundReason.${r.reason}`)}</span>
                  <Price
                    amountMinor={r.amountMinor}
                    currency={r.currency}
                    locale={locale}
                  />
                  {r.legalDueAt &&
                  r.status !== "SUCCEEDED" &&
                  r.status !== "MANUAL_DONE" ? (
                    <span className="text-sm text-ink-muted">
                      {t("detail.refundDue", { date: when(r.legalDueAt) })}
                    </span>
                  ) : null}
                </div>
                {r.manualReference ? (
                  <p className="text-sm text-ink-muted">
                    {t("detail.manualReference", { reference: "" })}
                    <bdi dir="ltr">{r.manualReference}</bdi>
                  </p>
                ) : null}
                {r.error ? (
                  <p className="text-sm text-reddot">
                    <bdi dir="ltr">{r.error}</bdi>
                  </p>
                ) : null}
                {r.failureConfirmedAt ? (
                  <p className="text-sm text-ink-muted">
                    {t("detail.failureConfirmed")}
                  </p>
                ) : null}
                {r.status === "MANUAL_REQUIRED" ? (
                  <ActionForm
                    action={markRefundDoneAction}
                    locale={locale}
                    hidden={{ refundId: r.id }}
                    submitLabel={t("refund.markDoneSubmit")}
                    submitSize="sm"
                    successText={t("refund.markedDone")}
                    errorNamespace={err}
                    testId="refund-done-form"
                  >
                    <FormField
                      name="reference"
                      label={t("refund.reference")}
                      hint={t("refund.markDoneHint")}
                      dir="ltr"
                      required
                    />
                  </ActionForm>
                ) : null}
                {r.status === "FAILED" && !r.failureConfirmedAt ? (
                  <ActionForm
                    action={confirmRefundFailedAction}
                    locale={locale}
                    hidden={{ refundId: r.id }}
                    submitLabel={t("refund.confirmFailed")}
                    submitVariant="secondary"
                    submitSize="sm"
                    successText={t("refund.confirmedFailed")}
                    errorNamespace={err}
                    confirm={{
                      title: t("refund.confirmFailed"),
                      message: t("refund.confirmFailedConfirm"),
                      confirmLabel: tc("save"),
                    }}
                  />
                ) : null}
                {r.status === "FAILED" && r.failureConfirmedAt ? (
                  <ActionForm
                    action={retryRefundAction}
                    locale={locale}
                    hidden={{ refundId: r.id }}
                    submitLabel={t("refund.retry")}
                    submitVariant="secondary"
                    submitSize="sm"
                    successText={t("refund.retried")}
                    errorNamespace={err}
                  />
                ) : null}
                {r.status === "UNKNOWN" || r.status === "PROVIDER_PENDING" ? (
                  <div className="flex flex-col gap-2">
                    {r.status === "UNKNOWN" ? (
                      <p className="text-sm">{t("refund.unknownHint")}</p>
                    ) : null}
                    <ActionForm
                      action={recheckRefundAction}
                      locale={locale}
                      hidden={{ refundId: r.id }}
                      submitLabel={t("refund.recheck")}
                      submitVariant="secondary"
                      submitSize="sm"
                      errorNamespace={err}
                      successText={t("refund.resolved")}
                    />
                  </div>
                ) : null}
                {r.status === "UNKNOWN" ? (
                  <div className="flex flex-col gap-2">
                    <ActionForm
                      action={resolveUnknownRefundAction}
                      locale={locale}
                      hidden={{ refundId: r.id, outcome: "refunded" }}
                      submitLabel={t("refund.resolveRefunded")}
                      submitVariant="secondary"
                      submitSize="sm"
                      successText={t("refund.resolved")}
                      errorNamespace={err}
                      confirm={{
                        title: t("refund.resolveRefunded"),
                        message: t("refund.resolveConfirm"),
                        confirmLabel: tc("save"),
                      }}
                    >
                      <FormField
                        name="reference"
                        label={t("refund.reference")}
                        dir="ltr"
                        required
                      />
                    </ActionForm>
                    <ActionForm
                      action={resolveUnknownRefundAction}
                      locale={locale}
                      hidden={{ refundId: r.id, outcome: "not_refunded" }}
                      submitLabel={t("refund.resolveNotRefunded")}
                      submitVariant="ghost"
                      submitSize="sm"
                      successText={t("refund.resolved")}
                      errorNamespace={err}
                      confirm={{
                        title: t("refund.resolveNotRefunded"),
                        message: t("refund.resolveConfirm"),
                        confirmLabel: tc("save"),
                      }}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("detail.documents")} testId="admin-documents">
        {detail.taxDocuments.length === 0 ? (
          <p>{t("detail.noDocuments")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.taxDocuments.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={d.status === "ISSUED" ? "neutral" : "danger"}>
                  {t(`docStatus.${d.status}`)}
                </Badge>
                <span>{t(`docKind.${d.kind}`)}</span>
                <bdi dir="ltr">{d.docNumber ?? d.marker}</bdi>
                {d.status === "ISSUED" && d.docNumber ? (
                  <a
                    href={
                      d.docUrl ??
                      localePath(
                        order.locale,
                        paths.printReceipt(d.docNumber, detail.buyerToken),
                      )
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("detail.viewDocument")}
                  </a>
                ) : null}
                {d.error ? (
                  <span className="text-sm text-reddot">
                    <bdi dir="ltr">{d.error}</bdi>
                  </span>
                ) : null}
                {d.status === "FAILED" ? (
                  <ActionForm
                    action={retryTaxDocumentAction}
                    locale={locale}
                    hidden={{ taxDocumentId: d.id }}
                    submitLabel={t("documents.retry")}
                    submitVariant="secondary"
                    submitSize="sm"
                    successText={t("documents.retried")}
                    errorNamespace={err}
                    confirm={{
                      title: t("documents.retry"),
                      message: t("documents.retryConfirm"),
                      confirmLabel: t("documents.retry"),
                    }}
                    inline
                  />
                ) : null}
                {d.status === "NEEDS_MANUAL" ? (
                  <ActionForm
                    action={manualTaxDocumentAction}
                    locale={locale}
                    hidden={{ taxDocumentId: d.id }}
                    submitLabel={t("documents.manualSubmit")}
                    submitSize="sm"
                    successText={t("documents.recorded")}
                    errorNamespace={err}
                    inline
                  >
                    <FormField
                      name="docNumber"
                      label={t("documents.docNumber")}
                      hint={t("documents.manual")}
                      dir="ltr"
                      required
                    />
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("detail.shipment")} testId="admin-shipment">
        {shipment ? (
          <>
            <p>
              <Badge>{t(`shipmentStatus.${shipment.status}`)}</Badge>{" "}
              <code
                className="text-xs text-ink-muted"
                data-testid="shipment-status"
              >
                {shipment.status}
              </code>{" "}
              {t(`method.${shipment.method}`)}
            </p>
            {shipment.trackingNumber ? (
              <p>
                {shipment.trackingUrl ? (
                  <a
                    href={shipment.trackingUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("detail.tracking", {
                      carrier: shipment.carrierName ?? shipment.carrier ?? "",
                      number: shipment.trackingNumber,
                    })}
                  </a>
                ) : (
                  t("detail.tracking", {
                    carrier: shipment.carrierName ?? shipment.carrier ?? "",
                    number: shipment.trackingNumber,
                  })
                )}
              </p>
            ) : null}
            {trackingAllowed ? (
              <div className="flex flex-col gap-2 border-t border-line pbs-3">
                <h3 className="font-sans font-semibold">
                  {t("tracking.title")}
                </h3>
                <p className="text-sm text-ink-muted">{t("tracking.intro")}</p>
                <ManualTrackingForm
                  action={manualTrackingAction}
                  orderId={order.id}
                  locale={locale}
                  defaults={{
                    carrierName: shipment.carrierName ?? "",
                    trackingNumber: shipment.trackingNumber ?? "",
                    trackingUrl: shipment.trackingUrl ?? "",
                  }}
                />
              </div>
            ) : null}
          </>
        ) : (
          <p>{t("detail.noShipment")}</p>
        )}
      </Section>

      <Section title={t("detail.emails")}>
        {detail.emails.length === 0 ? (
          <p>{t("detail.noEmails")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {detail.emails.map((m) => (
              <li key={m.id}>
                <bdi dir="ltr">{m.template}</bdi> · <bdi>{m.toEmail}</bdi> ·{" "}
                {t(`emailStatus.${m.status}` as "emailStatus.SENT")} ·{" "}
                {when(m.sentAt ?? m.createdAt)}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {detail.alerts.length > 0 ? (
        <Section title={t("detail.alerts")}>
          <ul className="flex flex-col gap-1 text-sm">
            {detail.alerts.map((a) => (
              <li key={a.id}>
                <Badge tone={a.severity === "CRITICAL" ? "danger" : "neutral"}>
                  {a.severity}
                </Badge>{" "}
                <bdi dir="ltr">{a.kind}</bdi> · {when(a.createdAt)}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={t("detail.timeline")}>
        {detail.timeline.length === 0 ? (
          <p>{t("detail.noTimeline")}</p>
        ) : (
          <ol className="flex flex-col gap-1 text-sm">
            {detail.timeline.map((e) => (
              <li key={e.id}>
                <span className="text-ink-muted">{when(e.at)}</span> ·{" "}
                <bdi dir="ltr">{e.action}</bdi> · <bdi dir="ltr">{e.actor}</bdi>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
