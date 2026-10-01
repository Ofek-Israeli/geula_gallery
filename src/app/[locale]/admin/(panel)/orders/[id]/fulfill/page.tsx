import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/fulfillment/ActionForm";
import { PackingPhotos } from "@/components/fulfillment/PackingPhotos";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Link } from "@/i18n/navigation";
import { countryName } from "@/lib/countries";
import { formatDateTime, jerusalemWallClock } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { toDecimalString } from "@/lib/money";
import { apiPaths, localePath, paths } from "@/lib/routes";
import { requireAdmin } from "@/server/next/guards";
import { getFulfillment } from "@/server/shipping/fulfillment-view";
import { MANUAL_EVENT_STATUSES } from "@/server/shipping/shipments";
import {
  artistDeliveredAction,
  artistOutAction,
  collectedAction,
  customsAction,
  eventAction,
  handedOverAction,
  labelAction,
  overrideAction,
  packAction,
  readyForPickupAction,
  staleLabelAction,
  trackingAction,
  unknownLabelAction,
} from "./actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/orders/[id]/fulfill">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "shipping.fulfill" });
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
      className="flex flex-col gap-4 border border-line p-4"
      data-testid={testId}
    >
      <h2 className="text-xl">{title}</h2>
      {children}
    </section>
  );
}

const PRE_LABEL = ["AWAITING_FULFILLMENT", "PACKED"];
const TRACKABLE_BY_HAND = [
  "AWAITING_FULFILLMENT",
  "PACKED",
  "LABEL_CREATED",
  "PICKUP_SCHEDULED",
];
const IN_FLIGHT = [
  "LABEL_CREATED",
  "PICKUP_SCHEDULED",
  "IN_TRANSIT",
  "CUSTOMS",
  "OUT_FOR_DELIVERY",
  "EXCEPTION",
];

/**
 * `/admin/orders/[id]/fulfill` (spec §5.5, §6.10): guards and the cancellation override, the
 * printables, then the three steps – pack (checklist, packed parcel, photos), customs
 * (international), ship (label with the claim protocol, manual tracking, pickup or artist
 * delivery behind the disclosure guard) – and the shipment events.
 */
export default async function FulfillPage({
  params,
}: PageProps<"/[locale]/admin/orders/[id]/fulfill">) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const v = await getFulfillment(ctx, id, locale);
  if (!v) notFound();
  const t = await getTranslations({ locale, namespace: "shipping" });
  const { order, shipment } = v;
  const status = shipment.status;
  const blocked = v.block !== null;
  const carrierMethod =
    shipment.method === "CARRIER_TABLE" || shipment.method === "QUOTED";
  const hidden = { orderId: order.id };
  const when = (d: Date | null | undefined) =>
    d ? formatDateTime(d, locale) : "—";
  const nowWall = jerusalemWallClock(new Date());
  const pad = (n: number) => String(n).padStart(2, "0");
  const nowLocal = `${nowWall.year}-${pad(nowWall.month)}-${pad(nowWall.day)}T${pad(nowWall.hour)}:${pad(nowWall.minute)}`;
  const customsDone =
    !v.international ||
    (!!shipment.contentsDescriptionEn &&
      shipment.exportDeclStatus !== "REQUIRED");

  return (
    <div className="flex max-w-4xl flex-col gap-6" data-testid="fulfill-page">
      <Link href={paths.admin.order(order.id)} className="text-sm">
        {t("fulfill.back")}
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl">
          {t("fulfill.title")} <bdi>{order.number}</bdi>
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="neutral">
            <span data-testid="fulfill-status">{t(`status.${status}`)}</span>
          </Badge>
          <span>{t(`method.${shipment.method}`)}</span>
          <span>· {countryName(order.shipCountry, locale)}</span>
          {shipment.trackingNumber ? (
            <span>
              · <bdi dir="ltr">{shipment.trackingNumber}</bdi>
            </span>
          ) : null}
        </div>
      </header>

      {v.block ? (
        <section
          role="alert"
          className="flex flex-col gap-3 border border-reddot p-4"
          data-testid="fulfill-blocked"
        >
          <h2 className="text-xl">{t("fulfill.blocked.title")}</h2>
          <p>
            {v.block.code === "FULFILLMENT_BLOCKED"
              ? t("fulfill.blocked.FULFILLMENT_BLOCKED", {
                  reason: t.has(
                    `fulfill.blockReason.${v.block.reason}` as never,
                  )
                    ? t(`fulfill.blockReason.${v.block.reason}` as never)
                    : v.block.reason,
                })
              : t(`fulfill.blocked.${v.block.code}`)}
          </p>
          {v.cancellations.length > 0 ? (
            <p className="text-sm">
              {t("fulfill.notices", {
                list: v.cancellations
                  .map((c) => `${c.number} (${when(c.receivedAt)})`)
                  .join(", "),
              })}
            </p>
          ) : null}
          {v.block.code === "CANCELLATION_PENDING" ? (
            <ActionForm
              action={overrideAction}
              locale={locale}
              hidden={hidden}
              submit={t("fulfill.override.submit")}
              variant="danger"
              testId="override-form"
            >
              <p className="font-medium">{t("fulfill.override.warning")}</p>
              <Field
                id="ov-reason"
                label={t("fulfill.override.reason")}
                required
              >
                {(c) => <Input {...c} name="reason" minLength={5} />}
              </Field>
            </ActionForm>
          ) : null}
        </section>
      ) : shipment.cancellationOverrideReason && v.cancellations.length > 0 ? (
        <p className="border border-hold p-3 text-sm" role="note">
          {t("fulfill.override.active", {
            reason: shipment.cancellationOverrideReason,
          })}
        </p>
      ) : null}

      <Section title={t("fulfill.docs.title")} testId="fulfill-docs">
        <ul className="flex flex-col gap-1">
          <li>
            <a
              href={localePath(locale, paths.admin.print.packingSlip(order.id))}
              target="_blank"
              rel="noreferrer"
              data-testid="doc-packing-slip"
            >
              {t("fulfill.docs.packingSlip")}
            </a>
          </li>
          {v.international ? (
            <li>
              <a
                href={localePath(
                  locale,
                  paths.admin.print.commercialInvoice(order.id),
                )}
                target="_blank"
                rel="noreferrer"
                data-testid="doc-commercial-invoice"
              >
                {t("fulfill.docs.commercialInvoice")}
              </a>
            </li>
          ) : null}
          <li>
            <a
              href={localePath(
                order.locale,
                paths.printDisclosure(order.number, v.buyerToken),
              )}
              target="_blank"
              rel="noreferrer"
              data-testid="doc-disclosure"
            >
              {t("fulfill.docs.disclosure")}
            </a>
          </li>
          {v.labelUrl ? (
            <li>
              <a href={v.labelUrl} data-testid="label-link">
                {t("fulfill.docs.label")}
              </a>
            </li>
          ) : null}
          {v.invoiceUrl ? (
            <li>
              <a href={v.invoiceUrl}>{t("fulfill.docs.carrierInvoice")}</a>
            </li>
          ) : null}
        </ul>
      </Section>

      <Section title={t("fulfill.items.title")}>
        <ul className="flex flex-col gap-3">
          {v.items.map((i) => (
            <li key={i.inventoryNumber} className="flex flex-col gap-1">
              <span className="font-medium">
                {i.title} · <bdi dir="ltr">{i.inventoryNumber}</bdi>
              </span>
              <span className="text-sm text-ink-muted">
                <bdi>{i.dimensionsText}</bdi> ·{" "}
                {t("fulfill.items.packaging", {
                  type: t(`packaging.${i.packagingType}`),
                })}
                {i.canBeRolled ? ` · ${t("fulfill.items.rollable")}` : ""}
                {i.coaIncluded ? ` · ${t("fulfill.items.coa")}` : ""}
              </span>
              <span className="text-sm text-ink-muted">
                {t("fulfill.items.suggested", {
                  l: Math.ceil(i.suggested.lengthMm / 10),
                  w: Math.ceil(i.suggested.widthMm / 10),
                  h: Math.ceil(i.suggested.heightMm / 10),
                  kg: (i.suggested.weightG / 1000).toFixed(1),
                })}
              </span>
            </li>
          ))}
        </ul>
        <div className="text-sm">
          <p className="font-medium">{t("fulfill.shipTo")}</p>
          <address className="not-italic" dir="auto">
            {v.addressLines.map((l) => (
              <span key={l} className="block">
                {l}
              </span>
            ))}
          </address>
        </div>
      </Section>

      {shipment.method !== "LOCAL_PICKUP" ? (
        <Section title={t("fulfill.pack.title")} testId="pack-section">
          {PRE_LABEL.includes(status) && !blocked ? (
            <ActionForm
              action={packAction}
              locale={locale}
              hidden={hidden}
              submit={
                status === "PACKED"
                  ? t("fulfill.pack.update")
                  : t("fulfill.pack.submit")
              }
              testId="pack-form"
            >
              <fieldset className="flex flex-col gap-2">
                <legend className="font-medium">
                  {t("fulfill.pack.checklist")}
                </legend>
                {v.checklist.map((c) => (
                  <Checkbox
                    key={c.item}
                    id={`ck-${c.item}`}
                    name="checklist"
                    value={c.item}
                    defaultChecked={c.checked}
                    required={c.required}
                    label={t(`checklist.${c.item}`)}
                  />
                ))}
              </fieldset>
              {v.defaults.packages.map((p, n) => (
                <fieldset
                  // biome-ignore lint/suspicious/noArrayIndexKey: parcels have no id
                  key={n}
                  className="grid grid-cols-2 gap-3 md:grid-cols-4"
                >
                  <legend className="col-span-full font-medium">
                    {t("fulfill.pack.package", { n: n + 1 })}
                  </legend>
                  {(
                    [
                      ["lengthMm", "length", p.lengthMm],
                      ["widthMm", "width", p.widthMm],
                      ["heightMm", "height", p.heightMm],
                      ["weightG", "weight", p.weightG],
                    ] as const
                  ).map(([name, label, value]) => (
                    <Field
                      key={name}
                      id={`pk-${n}-${name}`}
                      label={t(`fulfill.pack.${label}`)}
                      required
                    >
                      {(c) => (
                        <Input
                          {...c}
                          name={name}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          defaultValue={value}
                        />
                      )}
                    </Field>
                  ))}
                </fieldset>
              ))}
              <PackingPhotos
                uploadUrl={apiPaths.adminUploads("packing")}
                existing={v.photos}
                required={v.photosRequired}
              />
            </ActionForm>
          ) : (
            <p className="text-sm" data-testid="pack-summary">
              {shipment.packingPhotoKeys.length > 0
                ? t("fulfill.pack.uploaded", {
                    count: shipment.packingPhotoKeys.length,
                  })
                : null}{" "}
              {status === "AWAITING_FULFILLMENT" ? "" : t("fulfill.pack.done")}
            </p>
          )}
        </Section>
      ) : null}

      {v.international ? (
        <Section title={t("fulfill.customs.title")} testId="customs-section">
          <p className="text-sm">
            {v.exportRequiredByValue
              ? t("fulfill.customs.exportRequired", {
                  usd: v.exportThresholdUsd,
                })
              : t("fulfill.customs.exportNotRequired")}{" "}
            {t("fulfill.customs.status", {
              status: t(
                `fulfill.customs.exportStatus.${shipment.exportDeclStatus}`,
              ),
            })}
          </p>
          {shipment.commercialInvoiceNumber ? (
            <p className="text-sm">
              {t("fulfill.customs.invoice", {
                number: shipment.commercialInvoiceNumber,
              })}
            </p>
          ) : null}
          {PRE_LABEL.includes(status) && !blocked ? (
            <ActionForm
              action={customsAction}
              locale={locale}
              hidden={hidden}
              submit={t("fulfill.customs.submit")}
              testId="customs-form"
            >
              <div className="grid gap-3 md:grid-cols-2">
                <Field id="cu-hs" label={t("fulfill.customs.hsCode")} required>
                  {(c) => (
                    <Input
                      {...c}
                      name="hsCode"
                      dir="ltr"
                      defaultValue={shipment.hsCode ?? "9701.91"}
                    />
                  )}
                </Field>
                <Field
                  id="cu-declared"
                  label={t("fulfill.customs.declared", {
                    currency: shipment.declaredCurrency ?? order.currency,
                  })}
                  required
                >
                  {(c) => (
                    <Input
                      {...c}
                      name="declaredValue"
                      inputMode="decimal"
                      dir="ltr"
                      defaultValue={toDecimalString(
                        v.defaults.declaredValueMinor,
                      )}
                    />
                  )}
                </Field>
              </div>
              <Field
                id="cu-desc"
                label={t("fulfill.customs.description")}
                hint={t("fulfill.customs.descriptionHint")}
                required
              >
                {(c) => (
                  <Input
                    {...c}
                    name="contentsDescriptionEn"
                    dir="ltr"
                    lang="en"
                    defaultValue={v.defaults.customsDescription}
                  />
                )}
              </Field>
              <Field
                id="cu-insured"
                label={t("fulfill.customs.insured")}
                hint={t("fulfill.customs.insuredHint", {
                  cap: v.insuranceCapIls,
                })}
              >
                {(c) => (
                  <Input
                    {...c}
                    name="insuredValue"
                    inputMode="decimal"
                    dir="ltr"
                    defaultValue={toDecimalString(v.defaults.insuredValueMinor)}
                  />
                )}
              </Field>
              {shipment.exportDeclStatus !== "NOT_REQUIRED" ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="font-medium">
                    {t("fulfill.customs.exportDecl")}
                  </legend>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="exportDecl"
                      value="PENDING_CARRIER"
                      defaultChecked={shipment.exportDeclStatus !== "RECORDED"}
                    />
                    {t("fulfill.customs.pendingCarrier")}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="exportDecl"
                      value="RECORDED"
                      defaultChecked={shipment.exportDeclStatus === "RECORDED"}
                    />
                    {t("fulfill.customs.recorded")}
                  </label>
                  <Field id="cu-exp" label={t("fulfill.customs.exportNumber")}>
                    {(c) => (
                      <Input
                        {...c}
                        name="exportNumber"
                        dir="ltr"
                        defaultValue={shipment.exportDeclarationNumber ?? ""}
                      />
                    )}
                  </Field>
                </fieldset>
              ) : null}
            </ActionForm>
          ) : null}
        </Section>
      ) : null}

      <Section title={t("fulfill.ship.title")} testId="ship-section">
        {carrierMethod ? (
          <>
            {status === "AWAITING_FULFILLMENT" ? (
              <p className="text-sm">{t("fulfill.ship.packFirst")}</p>
            ) : null}
            {status === "PACKED" && v.labelCarrier && !blocked ? (
              <>
                {customsDone ? null : (
                  <p className="text-sm">{t("fulfill.ship.customsFirst")}</p>
                )}
                <ActionForm
                  action={labelAction}
                  locale={locale}
                  hidden={{ ...hidden, shipmentId: shipment.id }}
                  submit={t("fulfill.ship.buyLabel", {
                    carrier: v.labelCarrier,
                  })}
                  confirm={{
                    message: t("fulfill.ship.buyMessage"),
                    confirmLabel: t("fulfill.ship.buyConfirm"),
                  }}
                  testId="label-form"
                />
              </>
            ) : null}
            {status === "LABEL_UNKNOWN" ? (
              <div
                className="flex flex-col gap-3 border border-hold p-3"
                data-testid="label-unknown"
              >
                <h3 className="font-medium">
                  {t("fulfill.ship.unknown.title")}
                </h3>
                <p className="text-sm">
                  {t("fulfill.ship.unknown.body", { number: order.number })}
                </p>
                <ActionForm
                  action={unknownLabelAction}
                  locale={locale}
                  hidden={{ ...hidden, outcome: "none" }}
                  submit={t("fulfill.ship.unknown.none")}
                  variant="secondary"
                  testId="label-none-form"
                />
                <ActionForm
                  action={unknownLabelAction}
                  locale={locale}
                  hidden={{ ...hidden, outcome: "found" }}
                  submit={t("fulfill.ship.unknown.submitFound")}
                  variant="secondary"
                  testId="label-found-form"
                >
                  <Field
                    id="lb-waybill"
                    label={t("fulfill.ship.unknown.found")}
                    required
                  >
                    {(c) => <Input {...c} name="waybill" dir="ltr" />}
                  </Field>
                </ActionForm>
              </div>
            ) : null}
            {status === "LABEL_REQUESTED" && v.staleLabelRequest ? (
              <ActionForm
                action={staleLabelAction}
                locale={locale}
                hidden={hidden}
                submit={t("fulfill.ship.stale.submit")}
                variant="secondary"
                testId="label-stale-form"
              >
                <p className="text-sm">{t("fulfill.ship.stale.body")}</p>
              </ActionForm>
            ) : null}
            {shipment.trackingNumber ? (
              <p data-testid="tracking-number">
                {t("fulfill.ship.labelCreated", { waybill: "" })}
                <bdi dir="ltr">{shipment.trackingNumber}</bdi>
                {shipment.carrierName ? ` · ${shipment.carrierName}` : ""}
              </p>
            ) : null}
            {(status === "LABEL_CREATED" || status === "PICKUP_SCHEDULED") &&
            !blocked ? (
              <ActionForm
                action={handedOverAction}
                locale={locale}
                hidden={hidden}
                submit={t("fulfill.ship.handedOver")}
                variant="secondary"
                testId="handed-over-form"
              />
            ) : null}
            {TRACKABLE_BY_HAND.includes(status) && !blocked ? (
              <details className="border-t border-line pbs-3">
                <summary className="cursor-pointer font-medium">
                  {t("fulfill.ship.manual.title")}
                </summary>
                <ActionForm
                  action={trackingAction}
                  locale={locale}
                  hidden={hidden}
                  submit={t("fulfill.ship.manual.submit")}
                  testId="tracking-form"
                  className="pbs-3"
                >
                  <Field
                    id="mt-carrier"
                    label={t("fulfill.ship.manual.carrier")}
                    required
                  >
                    {(c) => (
                      <Input
                        {...c}
                        name="carrierName"
                        defaultValue={shipment.carrierName ?? ""}
                      />
                    )}
                  </Field>
                  <Field
                    id="mt-number"
                    label={t("fulfill.ship.manual.number")}
                    required
                  >
                    {(c) => <Input {...c} name="trackingNumber" dir="ltr" />}
                  </Field>
                  <Field id="mt-url" label={t("fulfill.ship.manual.url")}>
                    {(c) => <Input {...c} name="trackingUrl" type="url" />}
                  </Field>
                  <Checkbox
                    id="mt-handed"
                    name="handedOver"
                    label={t("fulfill.ship.manual.handedOver")}
                  />
                </ActionForm>
              </details>
            ) : null}
          </>
        ) : null}

        {shipment.method === "LOCAL_PICKUP" ? (
          <>
            <p className="text-sm">
              {t("fulfill.ship.pickup.address", { address: v.pickupAddress })}
            </p>
            {status === "AWAITING_FULFILLMENT" && !blocked ? (
              <ActionForm
                action={readyForPickupAction}
                locale={locale}
                hidden={hidden}
                submit={t("fulfill.ship.pickup.ready")}
                testId="ready-pickup-form"
              />
            ) : null}
            {status === "READY_FOR_PICKUP" ? (
              <HandOverForm
                action={collectedAction}
                locale={locale}
                hidden={hidden}
                submit={t("fulfill.ship.pickup.collected")}
                testId="collected-form"
                disclosureSentAt={order.disclosureSentAt}
                labels={{
                  sent: (d) =>
                    t("fulfill.ship.pickup.disclosureSent", { date: d }),
                  notSent: t("fulfill.ship.pickup.disclosureNotSent"),
                  check: t("fulfill.ship.pickup.handedOverCheck"),
                }}
                when={when}
              />
            ) : null}
          </>
        ) : null}

        {shipment.method === "ARTIST_DELIVERY" ? (
          <>
            {status === "PACKED" && !blocked ? (
              <ActionForm
                action={artistOutAction}
                locale={locale}
                hidden={hidden}
                submit={t("fulfill.ship.artist.out")}
                testId="artist-out-form"
              />
            ) : null}
            {status === "OUT_FOR_DELIVERY" ? (
              <HandOverForm
                action={artistDeliveredAction}
                locale={locale}
                hidden={hidden}
                submit={t("fulfill.ship.artist.delivered")}
                testId="artist-delivered-form"
                disclosureSentAt={order.disclosureSentAt}
                labels={{
                  sent: (d) =>
                    t("fulfill.ship.pickup.disclosureSent", { date: d }),
                  notSent: t("fulfill.ship.pickup.disclosureNotSent"),
                  check: t("fulfill.ship.pickup.handedOverCheck"),
                }}
                when={when}
              />
            ) : null}
          </>
        ) : null}

        {["DELIVERED", "COLLECTED"].includes(status) ? (
          <p data-testid="fulfill-done">
            {t("fulfill.ship.done", { status: t(`status.${status}`) })}
          </p>
        ) : null}
      </Section>

      <Section title={t("fulfill.events.title")} testId="events-section">
        {v.events.length === 0 ? (
          <p className="text-sm">{t("fulfill.events.none")}</p>
        ) : (
          <ol className="flex flex-col gap-2" data-testid="shipment-events">
            {v.events.map((e) => (
              <li key={e.id} className="text-sm">
                <span className="text-ink-muted">{when(e.occurredAt)}</span> ·{" "}
                {e.status ? (
                  <strong>{t(`status.${e.status}`)}</strong>
                ) : (
                  <bdi dir="ltr">{e.code}</bdi>
                )}
                {e.description ? (
                  <>
                    {" "}
                    · <bdi>{e.description}</bdi>
                  </>
                ) : null}
                {e.location ? (
                  <>
                    {" "}
                    · <bdi>{e.location}</bdi>
                  </>
                ) : null}
                <span className="text-ink-muted">
                  {" "}
                  ({t(`source.${e.source}`)})
                </span>
              </li>
            ))}
          </ol>
        )}
        {shipment.carrier === "MANUAL" &&
        carrierMethod &&
        IN_FLIGHT.includes(status) ? (
          <details className="border-t border-line pbs-3">
            <summary className="cursor-pointer font-medium">
              {t("fulfill.events.add")}
            </summary>
            <ActionForm
              action={eventAction}
              locale={locale}
              hidden={hidden}
              submit={t("fulfill.events.submit")}
              testId="event-form"
              className="pbs-3"
            >
              <Field id="ev-status" label={t("fulfill.events.status")}>
                {(c) => (
                  <Select
                    {...c}
                    name="status"
                    options={[
                      { value: "", label: t("fulfill.events.note") },
                      ...MANUAL_EVENT_STATUSES.map((s) => ({
                        value: s,
                        label: t(`status.${s}`),
                      })),
                    ]}
                  />
                )}
              </Field>
              <Field id="ev-at" label={t("fulfill.events.occurredAt")} required>
                {(c) => (
                  <Input
                    {...c}
                    name="occurredAt"
                    type="datetime-local"
                    dir="ltr"
                    defaultValue={nowLocal}
                  />
                )}
              </Field>
              <Field
                id="ev-desc"
                label={t("fulfill.events.description")}
                required
              >
                {(c) => <Input {...c} name="description" />}
              </Field>
              <Field id="ev-loc" label={t("fulfill.events.location")}>
                {(c) => <Input {...c} name="location" />}
              </Field>
            </ActionForm>
          </details>
        ) : null}
      </Section>
    </div>
  );
}

function HandOverForm({
  action,
  locale,
  hidden,
  submit,
  testId,
  disclosureSentAt,
  labels,
  when,
}: {
  action: typeof collectedAction | typeof artistDeliveredAction;
  locale: "he" | "en";
  hidden: Record<string, string>;
  submit: string;
  testId: string;
  disclosureSentAt: Date | null;
  labels: { sent: (date: string) => string; notSent: string; check: string };
  when: (d: Date | null | undefined) => string;
}) {
  return (
    <ActionForm
      action={action}
      locale={locale}
      hidden={hidden}
      submit={submit}
      testId={testId}
    >
      {disclosureSentAt ? (
        <p className="text-sm">{labels.sent(when(disclosureSentAt))}</p>
      ) : (
        <>
          <p className="text-sm font-medium">{labels.notSent}</p>
          <Checkbox
            id={`${testId}-disclosure`}
            name="disclosureHandedOver"
            label={labels.check}
          />
        </>
      )}
    </ActionForm>
  );
}
