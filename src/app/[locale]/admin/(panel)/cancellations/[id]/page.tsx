import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Link } from "@/i18n/navigation";
import { formatDate, formatDateTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { formatMoney, toDecimalString } from "@/lib/money";
import { paths } from "@/lib/routes";
import { getCancellationDetail } from "@/server/cancellations/service";
import { requireAdmin } from "@/server/next/guards";
import { AdminActionForm } from "../AdminActionForm";
import {
  acceptAction,
  closeAction,
  duplicateAction,
  inspectionAction,
  matchAction,
  refundAction,
  rejectAction,
  relistAction,
  returnReceivedAction,
} from "../actions";

const REJECT_TEMPLATES = [
  "OUTSIDE_WINDOW",
  "NOT_IDENTIFIED",
  "EXCLUDED_ITEM",
  "WITHDRAWN",
] as const;

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/cancellations/[id]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "cancel.admin" });
  return { title: t("listTitle") };
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="contents">
      <dt className="text-ink-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * `/admin/cancellations/[id]` (spec §5.7 steps 5–9, §6.10): the notice (masked ID), matching, the
 * conversation source, the window and fee, "Refund due by <date>" from the notice, and the
 * decision flow (accept / reject / duplicate → return → inspection → close → relist).
 */
export default async function CancellationDetailPage({
  params,
}: PageProps<"/[locale]/admin/cancellations/[id]">) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getCancellationDetail(ctx, id);
  if (!d) notFound();
  const [t, tc, tAll] = await Promise.all([
    getTranslations({ locale, namespace: "cancel.admin" }),
    getTranslations({ locale, namespace: "cancel" }),
    getTranslations({ locale }),
  ]);
  /** A translated enum label (`<namespace>.<group>.<value>`), else the raw value. */
  const label = (key: string, raw: string) =>
    tAll.has(key as never) ? tAll(key as never) : raw;
  const c = d.cancellation;
  const o = d.order;
  const a = d.assessment;
  const money = (minor: number | null | undefined) =>
    o && minor !== null && minor !== undefined
      ? formatMoney(minor, o.currency, locale)
      : "—";

  return (
    <div
      className="flex max-w-4xl flex-col gap-8"
      data-testid="cancellation-detail"
    >
      <Link href={paths.admin.cancellations()} className="underline">
        {t("back")}
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl">{t("detailTitle", { number: c.number })}</h1>
        <div className="flex flex-wrap gap-2">
          <Badge tone={c.status === "RECEIVED" ? "hold" : "neutral"}>
            <span data-testid="cancellation-status">
              {tc(`status.${c.status}`)}
            </span>
          </Badge>
          <Badge>{tc(`returnStatus.${c.returnStatus}`)}</Badge>
          {c.possibleDuplicate ? (
            <Badge tone="danger">{t("duplicateBadge")}</Badge>
          ) : null}
        </div>
        {c.refundDueAt &&
        (c.status === "RECEIVED" || c.status === "ACCEPTED") ? (
          <p
            className="text-lg font-semibold text-reddot"
            data-testid="refund-due"
          >
            {t("refundDueBy", { date: formatDateTime(c.refundDueAt, locale) })}
          </p>
        ) : null}
        {d.duplicateOf ? (
          <p>
            <Link
              href={paths.admin.cancellation(d.duplicateOf.id)}
              className="underline"
            >
              {t("duplicateOf", { number: d.duplicateOf.number })}
            </Link>
          </p>
        ) : null}
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl">{t("notice")}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
          <Row label={tc("labels.fullName")}>{c.fullName}</Row>
          {d.idNumberMasked ? (
            <Row label={tc("labels.idNumber")}>
              <bdi dir="ltr" data-testid="masked-id">
                {d.idNumberMasked}
              </bdi>
            </Row>
          ) : null}
          {c.orderNumberInput ? (
            <Row label={tc("labels.orderNumber")}>
              <bdi dir="ltr">{c.orderNumberInput}</bdi>
            </Row>
          ) : null}
          {c.email ? (
            <Row label={tc("labels.email")}>
              <bdi dir="ltr">{c.email}</bdi>
            </Row>
          ) : null}
          {c.phone ? (
            <Row label={tc("labels.phone")}>
              <bdi dir="ltr">{c.phone}</bdi>
            </Row>
          ) : null}
          <Row label={tc("labels.channel")}>{tc(`channel.${c.channel}`)}</Row>
          <Row label={tc("labels.receivedAt")}>
            {formatDateTime(c.receivedAt, locale)}
          </Row>
          {c.reason ? (
            <Row label={tc("labels.reason")}>{tc(`reason.${c.reason}`)}</Row>
          ) : null}
          <Row label={tc("labels.eligibleGroup")}>
            {tc(`eligibleGroup.${c.eligibleGroup}`)}
          </Row>
          {c.message ? (
            <Row label={tc("labels.message")}>
              <span className="whitespace-pre-wrap">{c.message}</span>
            </Row>
          ) : null}
          {c.decisionReason ? (
            <Row label={t("rejectReason")}>{c.decisionReason}</Row>
          ) : null}
        </dl>
        {d.related.length > 0 ? (
          <div>
            <h3 className="font-semibold">{t("related")}</h3>
            <ul className="flex flex-wrap gap-3">
              {d.related.map((r) => (
                <li key={r.id}>
                  <Link
                    href={paths.admin.cancellation(r.id)}
                    className="underline"
                  >
                    <bdi dir="ltr">{r.number}</bdi>
                  </Link>{" "}
                  ({tc(`status.${r.status}`)})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl">{t("order")}</h2>
        {!o ? (
          <>
            <p className="text-ink-muted">{t("noOrder")}</p>
            <AdminActionForm
              action={matchAction}
              locale={locale}
              cancellationId={c.id}
              submitLabel={t("match")}
              testId="match-order"
            >
              <Field id="m-order" label={t("matchLabel")} required>
                {(f) => (
                  <Input
                    {...f}
                    name="orderNumber"
                    dir="ltr"
                    defaultValue={c.orderNumberInput ?? ""}
                  />
                )}
              </Field>
            </AdminActionForm>
          </>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
            <Row label={t("order")}>
              <Link href={paths.admin.order(o.id)} className="underline">
                <bdi dir="ltr">{o.number}</bdi>
              </Link>
            </Row>
            <Row label={t("orderStatus")}>
              <span data-testid="order-status" data-status={o.status}>
                {label(`admin-orders.status.${o.status}`, o.status)}
              </span>
            </Row>
            <Row label={t("shipmentStatus")}>
              {d.shipmentStatus
                ? label(
                    `admin-orders.shipmentStatus.${d.shipmentStatus}`,
                    d.shipmentStatus,
                  )
                : "—"}
            </Row>
            <Row label={t("deliveredAt")}>
              {o.deliveredAt
                ? formatDateTime(o.deliveredAt, locale)
                : t("notDelivered")}
            </Row>
            <Row label={t("conversation")}>
              {o.conversationTookPlace
                ? t("conversationSource", {
                    source: o.conversationSource ?? "—",
                  })
                : t("conversationNo")}
            </Row>
            <Row label={t("artworks")}>
              {d.artworks
                .map(
                  (w) =>
                    `${w.title} (${label(`admin-catalog.status.${w.saleStatus}`, w.saleStatus)})`,
                )
                .join(", ")}
            </Row>
            {a ? (
              <>
                <Row label={t("window")}>
                  {a.window.beforeDelivery
                    ? t("windowBeforeDelivery")
                    : `${a.window.length === "4_MONTHS" ? t("length4m") : t("length14")} · ${t(
                        "windowEnds",
                        {
                          date: formatDate(a.window.end ?? new Date(), locale),
                        },
                      )} · ${a.withinWindow ? t("within") : t("outside")}`}
                </Row>
                <Row label={t("fee")}>
                  <span data-testid="suggested-fee">
                    {money(a.suggestedFeeMinor)}
                  </span>
                </Row>
                <Row label={t("refundAmount")}>
                  {money(a.refundAmountMinor)}
                </Row>
              </>
            ) : (
              <>
                {c.feeMinor !== null ? (
                  <Row label={t("fee")}>{money(c.feeMinor)}</Row>
                ) : null}
                {c.refundAmountMinor !== null ? (
                  <Row label={t("refundAmount")}>
                    {money(c.refundAmountMinor)}
                  </Row>
                ) : null}
              </>
            )}
          </dl>
        )}
        {a?.conversationUncertain && c.status === "RECEIVED" ? (
          <p className="rounded-sm border border-hold p-2 text-sm text-hold">
            {t("conversationHint")}
          </p>
        ) : null}
      </section>

      {c.status === "RECEIVED" ? (
        <section className="flex flex-col gap-6">
          <h2 className="text-xl">{t("decision")}</h2>
          {o && a ? (
            <AdminActionForm
              action={acceptAction}
              locale={locale}
              cancellationId={c.id}
              submitLabel={t("accept")}
              variant="primary"
              confirm={t("acceptConfirm")}
              testId="accept-cancellation"
            >
              <Field id="a-fee" label={t("feeInput")} hint={t("feeHint")}>
                {(f) => (
                  <Input
                    {...f}
                    name="feeMinor"
                    dir="ltr"
                    inputMode="decimal"
                    defaultValue={toDecimalString(a.suggestedFeeMinor)}
                  />
                )}
              </Field>
              {c.eligibleGroup !== "NONE" ? (
                <Checkbox
                  id="a-grant"
                  name="grantFourMonths"
                  label={t("grant4m")}
                  defaultChecked
                />
              ) : null}
              <Field id="a-note" label={t("note")}>
                {(f) => <Input {...f} name="note" />}
              </Field>
            </AdminActionForm>
          ) : null}
          <AdminActionForm
            action={rejectAction}
            locale={locale}
            cancellationId={c.id}
            submitLabel={t("reject")}
            variant="danger"
            testId="reject-cancellation"
          >
            <Field id="r-reason" label={t("rejectReason")} required>
              {(f) => (
                <Select
                  {...f}
                  name="reason"
                  options={REJECT_TEMPLATES.map((r) => ({
                    value: t(`rejectTemplates.${r}`),
                    label: t(`rejectTemplates.${r}`),
                  }))}
                />
              )}
            </Field>
          </AdminActionForm>
          <AdminActionForm
            action={duplicateAction}
            locale={locale}
            cancellationId={c.id}
            submitLabel={t("closeDuplicate")}
            testId="close-duplicate"
          >
            <Field id="dup" label={t("duplicateNumber")} required>
              {(f) => (
                <Input
                  {...f}
                  name="duplicateOf"
                  dir="ltr"
                  defaultValue={d.duplicateOf?.number ?? ""}
                />
              )}
            </Field>
          </AdminActionForm>
        </section>
      ) : null}

      {c.status === "ACCEPTED" || c.status === "CLOSED" ? (
        <section className="flex flex-col gap-5">
          <h2 className="text-xl">{t("refund")}</h2>
          {d.refund ? (
            <p data-testid="refund-status">
              {money(d.refund.amountMinor)} ·{" "}
              {t("refundStatus", { status: d.refund.status })}
            </p>
          ) : c.status === "ACCEPTED" && (c.refundAmountMinor ?? 0) > 0 ? (
            <>
              {c.returnStatus === "AWAITING_RETURN" ? (
                <p className="text-sm text-hold">{t("returnWarning")}</p>
              ) : null}
              <AdminActionForm
                action={refundAction}
                locale={locale}
                cancellationId={c.id}
                submitLabel={`${t("refundNow")} (${money(c.refundAmountMinor)})`}
                variant="primary"
                testId="refund-now"
              />
            </>
          ) : null}

          {c.returnStatus !== "NOT_APPLICABLE" ? (
            <div className="flex flex-col gap-3">
              <h2 className="text-xl">{t("returnTitle")}</h2>
              {c.returnStatus === "AWAITING_RETURN" ? (
                <AdminActionForm
                  action={returnReceivedAction}
                  locale={locale}
                  cancellationId={c.id}
                  submitLabel={t("returnReceived")}
                  testId="return-received"
                >
                  <Field id="rt" label={t("returnTracking")}>
                    {(f) => <Input {...f} name="tracking" dir="ltr" />}
                  </Field>
                </AdminActionForm>
              ) : null}
              {c.returnStatus === "RECEIVED" ? (
                <AdminActionForm
                  action={inspectionAction}
                  locale={locale}
                  cancellationId={c.id}
                  submitLabel={t("inspectOk")}
                  testId="inspection"
                >
                  <Field id="in-res" label={t("inspectionNotes")}>
                    {(f) => (
                      <Select
                        {...f}
                        name="result"
                        options={[
                          { value: "ok", label: t("inspectOk") },
                          { value: "damaged", label: t("inspectDamaged") },
                        ]}
                      />
                    )}
                  </Field>
                  <Field id="in-notes" label={t("inspectionNotes")}>
                    {(f) => <Input {...f} name="notes" />}
                  </Field>
                </AdminActionForm>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-6">
            {c.status === "ACCEPTED" ? (
              <AdminActionForm
                action={closeAction}
                locale={locale}
                cancellationId={c.id}
                submitLabel={t("close")}
                testId="close-cancellation"
              />
            ) : null}
            {o?.status === "CANCELLED" &&
            d.artworks.some((w) => w.saleStatus === "SOLD") ? (
              <AdminActionForm
                action={relistAction}
                locale={locale}
                cancellationId={c.id}
                submitLabel={
                  c.returnStatus === "INSPECTED_DAMAGED"
                    ? t("markDamaged")
                    : t("relist")
                }
                testId="relist"
              />
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
