import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  ArtworkPhotoUpload,
  UseSuggestionButton,
} from "@/components/admin/ArtworkPhotos";
import {
  ActionForm,
  FormCheckbox,
  FormField,
  ShowOnError,
} from "@/components/admin/forms";
import { ARTWORK_STATUS_TONE } from "@/components/admin/tones";
import { Badge } from "@/components/ui/Badge";
import { Price } from "@/components/ui/Price";
import { Link } from "@/i18n/navigation";
import { ZONE_IDS } from "@/lib/countries";
import { formatDate, formatTime, jerusalemDateKey } from "@/lib/format";
import { isLocale, type Locale } from "@/lib/locale";
import { toDecimalString } from "@/lib/money";
import { paths } from "@/lib/routes";
import { getAdminArtwork } from "@/server/admin/catalog";
import {
  ARTWORK_MEDIUMS,
  ARTWORK_SURFACES,
  HOLD_REASONS,
  IMAGE_ROLES,
  PACKAGING_TYPES,
  packingSuggestion,
} from "@/server/catalog/mutations";
import { requireAdmin } from "@/server/next/guards";
import {
  damagedAction,
  deleteDraftAction,
  deleteImageAction,
  forSaleAction,
  moveImageAction,
  notForSaleAction,
  offlineHoldAction,
  publishAction,
  releaseHoldAction,
  relistAction,
  soldOfflineAction,
  unpublishAction,
  updateCustomsAction,
  updateDetailsAction,
  updateImageAction,
  updatePriceAction,
  updateShippingAction,
  updateSizeAction,
} from "../actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/artworks/[id]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-catalog.list" });
  return { title: t("title") };
}

const cm = (mm: number | null) =>
  mm === null ? "" : String(Math.round(mm) / 10);
const kg = (g: number | null) => (g === null ? "" : String(g / 1000));
const major = (minor: number | null) =>
  minor === null ? "" : toDecimalString(minor);

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="flex scroll-mt-4 flex-col gap-4 border border-line p-4"
      data-testid={`section-${id}`}
    >
      <h2 id={`${id}-title`} className="text-xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * `/admin/artworks/[id]` (spec §6.10): Photos, Details, Size, Price & sale, Shipping (packing with
 * "use suggestion", live class and estimates), Customs, Publish checklist, and the §5.9 sale-state
 * actions (offline hold, offline sale, not for sale, relist) with the live-checkout override.
 */
export default async function ArtworkEditorPage({
  params,
  searchParams,
}: PageProps<"/[locale]/admin/artworks/[id]">) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const detail = await getAdminArtwork(ctx, id);
  if (!detail) notFound();
  const sp = await searchParams;
  const t = await getTranslations({ locale, namespace: "admin-catalog" });
  const tc = await getTranslations({ locale, namespace: "admin-shell.common" });
  const a = detail.artwork;
  const hidden = { artworkId: a.id };
  const save = { submitLabel: tc("save"), successText: tc("saved") };
  const err = "admin-catalog.errors";
  const slugLocked = a.publishedAt !== null;
  const suggestion = packingSuggestion(a);
  const hold = detail.hold;
  const holdLabel = hold
    ? {
        order: hold.orderNumber ?? "—",
        time: formatTime(hold.until, locale),
      }
    : null;
  const override =
    hold?.live && !hold.inFlight && holdLabel
      ? {
          title: t("sale.overrideTitle"),
          message: t("sale.overrideMessage", holdLabel),
          confirmLabel: t("sale.overrideConfirm"),
        }
      : undefined;
  const overrideHidden: Record<string, string> = override
    ? { ...hidden, confirmOverride: "on" }
    : hidden;
  const saleBlocked = hold?.inFlight === true;

  return (
    <div className="flex max-w-4xl flex-col gap-6" data-testid="artwork-editor">
      <Link href={paths.admin.artworks()} className="text-sm">
        {t("editor.back")}
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl">{locale === "he" ? a.titleHe : a.titleEn}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={ARTWORK_STATUS_TONE[a.saleStatus]}>
            <span data-testid="artwork-sale-status">
              {t(`status.${a.saleStatus}`)}
            </span>
          </Badge>
          <Badge>
            <span data-testid="artwork-published">
              {a.isPublished ? t("list.published") : t("list.draft")}
            </span>
          </Badge>
          {a.isDemo ? <Badge>{tc("demo")}</Badge> : null}
          <span className="text-sm text-ink-muted">
            {t("editor.inventory", { number: a.inventoryNumber })}
          </span>
          {a.isPublished ? (
            <Link href={paths.artwork(a.slug)} className="text-sm">
              {t("editor.viewOnSite")}
            </Link>
          ) : null}
        </div>
        {sp.created ? <p role="status">{t("editor.created")}</p> : null}
        {hold && holdLabel ? (
          <p
            className={hold.live ? "font-medium text-reddot" : "text-ink-muted"}
            data-testid="artwork-live-hold"
          >
            {hold.inFlight
              ? t("editor.liveHoldInFlight", holdLabel)
              : hold.live
                ? t("editor.liveHold", holdLabel)
                : t("editor.lapsedHold", holdLabel)}
          </p>
        ) : null}
        <nav aria-label={t("editor.sections")}>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {[
              "publish",
              "sale",
              "photos",
              "details",
              "size",
              "price",
              "shipping",
              "customs",
            ].map((s) => (
              <li key={s}>
                <a href={`#${s}`}>
                  {t(
                    `editor.${s === "sale" ? "saleState" : s}` as "editor.photos",
                  )}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <Section id="publish" title={t("checklist.title")}>
        <ul className="flex flex-col gap-1" data-testid="publish-checklist">
          {detail.checklist.map((item) => (
            <li
              key={item.key}
              className="flex items-center gap-2"
              data-testid={`checklist-${item.key}`}
              data-ok={item.ok ? "true" : "false"}
            >
              <span aria-hidden="true">
                {!item.applies ? "–" : item.ok ? "✓" : "✗"}
              </span>
              <span>{t(`checklist.${item.key}`)}</span>
              <span className="text-sm text-ink-muted">
                (
                {!item.applies
                  ? t("checklist.notNeeded")
                  : item.ok
                    ? t("checklist.done")
                    : t("checklist.missing")}
                )
              </span>
            </li>
          ))}
        </ul>
        <p>
          {a.isPublished ? t("checklist.isPublished") : t("checklist.isDraft")}
        </p>
        {a.isPublished ? (
          <ActionForm
            action={unpublishAction}
            locale={locale}
            hidden={hidden}
            submitLabel={t("checklist.unpublish")}
            submitVariant="secondary"
            successText={t("checklist.unpublished")}
            errorNamespace={err}
            confirm={{
              title: t("checklist.unpublish"),
              message: t("checklist.unpublishConfirm"),
              confirmLabel: t("checklist.unpublish"),
            }}
          />
        ) : (
          <ActionForm
            action={publishAction}
            locale={locale}
            hidden={hidden}
            submitLabel={t("checklist.publish")}
            successText={t("checklist.published")}
            errorNamespace={err}
            testId="publish-form"
          />
        )}
      </Section>

      <Section id="sale" title={t("editor.saleState")}>
        <p>
          {t("sale.status", { status: t(`status.${a.saleStatus}`) })}
          {a.saleStatus === "ON_HOLD" && a.holdReason
            ? ` · ${t(`holdReason.${a.holdReason}`)}`
            : ""}
        </p>
        {a.holdNote ? <p>{t("sale.holdNote", { note: a.holdNote })}</p> : null}
        {detail.activeSale ? (
          <p className="text-sm text-ink-muted">
            {t("sale.soldOn", {
              date: formatDate(detail.activeSale.soldAt, locale),
            })}{" "}
            ·{" "}
            {t("sale.saleChannel", {
              channel: t(`channel.${detail.activeSale.channel}`),
            })}{" "}
            ·{" "}
            <Price
              amountMinor={detail.activeSale.priceMinor}
              currency={detail.activeSale.currency}
              locale={locale}
            />
          </p>
        ) : null}
        {saleBlocked ? null : (
          <SaleActions
            locale={locale}
            status={a.saleStatus}
            hidden={hidden}
            overrideHidden={overrideHidden}
            override={override}
            t={t}
            err={err}
          />
        )}
      </Section>

      <Section id="photos" title={t("editor.photos")}>
        <ArtworkPhotoUpload artworkId={a.id} />
        {detail.images.length === 0 ? (
          <p>{t("photos.none")}</p>
        ) : (
          <ol className="flex flex-col gap-6">
            {detail.images.map((img, i) => (
              <li
                key={img.id}
                className="flex flex-col gap-3 border-t border-line pbs-4 sm:flex-row"
                data-testid="artwork-image"
              >
                <div className="flex shrink-0 flex-col gap-2">
                  {/* biome-ignore lint/performance/noImgElement: admin preview */}
                  <img
                    src={img.src}
                    alt={locale === "he" ? img.altHe : img.altEn}
                    width={160}
                    height={160}
                    className="size-40 object-contain"
                    style={{ backgroundColor: img.dominantColor ?? undefined }}
                  />
                  <span className="text-sm">
                    {t("photos.image", { n: i + 1 })} · {t(`role.${img.role}`)}
                  </span>
                  {!img.altHe.trim() || !img.altEn.trim() ? (
                    <Badge tone="danger">{t("photos.missingAlt")}</Badge>
                  ) : null}
                </div>
                <div className="flex flex-1 flex-col gap-3">
                  <ActionForm
                    action={updateImageAction}
                    locale={locale}
                    hidden={{ imageId: img.id }}
                    errorNamespace={err}
                    testId="image-form"
                    {...save}
                  >
                    <FormField
                      name="role"
                      label={t("fields.role")}
                      type="select"
                      defaultValue={img.role}
                      options={IMAGE_ROLES.map((r) => ({
                        value: r,
                        label: t(`role.${r}`),
                      }))}
                    />
                    <FormField
                      name="altHe"
                      label={t("fields.altHe")}
                      hint={t("fields.altHint")}
                      defaultValue={img.altHe}
                    />
                    <FormField
                      name="altEn"
                      label={t("fields.altEn")}
                      defaultValue={img.altEn}
                      dir="ltr"
                    />
                    <FormField
                      name="creditLine"
                      label={t("fields.imageCredit")}
                      defaultValue={img.creditLine}
                    />
                  </ActionForm>
                  <div className="flex flex-wrap gap-2">
                    {i > 0 ? (
                      <ActionForm
                        action={moveImageAction}
                        locale={locale}
                        hidden={{ imageId: img.id, direction: "up" }}
                        submitLabel={t("photos.moveUp")}
                        submitVariant="ghost"
                        submitSize="sm"
                        errorNamespace={err}
                        inline
                      />
                    ) : null}
                    {i < detail.images.length - 1 ? (
                      <ActionForm
                        action={moveImageAction}
                        locale={locale}
                        hidden={{ imageId: img.id, direction: "down" }}
                        submitLabel={t("photos.moveDown")}
                        submitVariant="ghost"
                        submitSize="sm"
                        errorNamespace={err}
                        inline
                      />
                    ) : null}
                    <ActionForm
                      action={deleteImageAction}
                      locale={locale}
                      hidden={{ imageId: img.id }}
                      submitLabel={t("photos.delete")}
                      submitVariant="danger"
                      submitSize="sm"
                      errorNamespace={err}
                      inline
                      confirm={{
                        title: t("photos.delete"),
                        message: t("photos.deleteConfirm"),
                        confirmLabel: t("photos.delete"),
                      }}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section id="details" title={t("editor.details")}>
        <ActionForm
          action={updateDetailsAction}
          locale={locale}
          hidden={hidden}
          errorNamespace={err}
          testId="details-form"
          {...save}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="titleHe"
              label={t("fields.titleHe")}
              defaultValue={a.titleHe}
              required
            />
            <FormField
              name="titleEn"
              label={t("fields.titleEn")}
              defaultValue={a.titleEn}
              required
              dir="ltr"
            />
          </div>
          <FormField
            name="slug"
            label={t("fields.slug")}
            defaultValue={a.slug}
            hint={slugLocked ? t("fields.slugLocked") : t("new.slugHint")}
            readOnly={slugLocked}
            dir="ltr"
            required
          />
          <FormField
            name="descriptionHe"
            label={t("fields.descriptionHe")}
            type="textarea"
            defaultValue={a.descriptionHe}
          />
          <FormField
            name="descriptionEn"
            label={t("fields.descriptionEn")}
            type="textarea"
            defaultValue={a.descriptionEn}
            dir="ltr"
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              name="yearCreated"
              label={t("fields.yearCreated")}
              type="number"
              inputMode="numeric"
              defaultValue={a.yearCreated}
            />
            <FormField
              name="medium"
              label={t("fields.medium")}
              type="select"
              defaultValue={a.medium}
              options={ARTWORK_MEDIUMS.map((m) => ({
                value: m,
                label: t(`medium.${m}`),
              }))}
            />
            <FormField
              name="surface"
              label={t("fields.surface")}
              type="select"
              defaultValue={a.surface}
              options={ARTWORK_SURFACES.map((s) => ({
                value: s,
                label: t(`surface.${s}`),
              }))}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="mediumDetailHe"
              label={t("fields.mediumDetailHe")}
              hint={t("fields.mediumDetailHint")}
              defaultValue={a.mediumDetailHe}
            />
            <FormField
              name="mediumDetailEn"
              label={t("fields.mediumDetailEn")}
              defaultValue={a.mediumDetailEn}
              dir="ltr"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="seriesId"
              label={t("fields.series")}
              type="select"
              defaultValue={a.seriesId ?? ""}
              placeholder={t("fields.noSeries")}
              options={detail.series.map((s) => ({
                value: s.id,
                label: locale === "he" ? s.nameHe : s.nameEn,
              }))}
            />
            <FormField
              name="sortOrder"
              label={t("fields.sortOrder")}
              hint={t("fields.sortOrderHint")}
              type="number"
              inputMode="numeric"
              defaultValue={a.sortOrder}
            />
          </div>
          <FormCheckbox
            name="featured"
            label={t("fields.featured")}
            defaultChecked={a.featured}
          />
        </ActionForm>
      </Section>

      <Section id="size" title={t("editor.size")}>
        <ActionForm
          action={updateSizeAction}
          locale={locale}
          hidden={hidden}
          errorNamespace={err}
          {...save}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              name="heightCm"
              label={t("fields.heightCm")}
              type="number"
              defaultValue={cm(a.heightMm)}
              required
            />
            <FormField
              name="widthCm"
              label={t("fields.widthCm")}
              type="number"
              defaultValue={cm(a.widthMm)}
              required
            />
            <FormField
              name="depthCm"
              label={t("fields.depthCm")}
              type="number"
              defaultValue={cm(a.depthMm)}
            />
          </div>
          <FormCheckbox
            name="framed"
            label={t("fields.framed")}
            defaultChecked={a.framed}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              name="frameHeightCm"
              label={t("fields.frameHeightCm")}
              type="number"
              defaultValue={cm(a.frameHeightMm)}
            />
            <FormField
              name="frameWidthCm"
              label={t("fields.frameWidthCm")}
              type="number"
              defaultValue={cm(a.frameWidthMm)}
            />
            <FormField
              name="frameDepthCm"
              label={t("fields.frameDepthCm")}
              type="number"
              defaultValue={cm(a.frameDepthMm)}
            />
          </div>
          <FormField
            name="glazing"
            label={t("fields.glazing")}
            type="select"
            defaultValue={a.glazing}
            options={(["NONE", "GLASS", "ACRYLIC"] as const).map((g) => ({
              value: g,
              label: t(`glazing.${g}`),
            }))}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <FormCheckbox
              name="readyToHang"
              label={t("fields.readyToHang")}
              defaultChecked={a.readyToHang}
            />
            <FormCheckbox
              name="signed"
              label={t("fields.signed")}
              defaultChecked={a.signed}
            />
            <FormCheckbox
              name="paintedEdges"
              label={t("fields.paintedEdges")}
              defaultChecked={a.paintedEdges}
            />
            <FormCheckbox
              name="coaIncluded"
              label={t("fields.coaIncluded")}
              defaultChecked={a.coaIncluded}
            />
          </div>
        </ActionForm>
      </Section>

      <Section id="price" title={t("editor.price")}>
        <ActionForm
          action={updatePriceAction}
          locale={locale}
          hidden={hidden}
          errorNamespace={err}
          testId="price-form"
          {...save}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="priceIls"
              label={t("fields.priceIls")}
              type="number"
              defaultValue={major(a.priceIlsMinor)}
            />
            <FormField
              name="priceUsd"
              label={t("fields.priceUsd")}
              hint={t("fields.priceUsdHint")}
              type="number"
              defaultValue={major(a.priceUsdMinor)}
            />
          </div>
          <FormCheckbox
            name="priceOnRequest"
            label={t("fields.priceOnRequest")}
            defaultChecked={a.priceOnRequest}
          />
          <FormCheckbox
            name="offersEnabled"
            label={t("fields.offersEnabled")}
            defaultChecked={a.offersEnabled}
          />
          <FormField
            name="offerAutoDeclineBelowIls"
            label={t("fields.offerAutoDeclineBelowIls")}
            type="number"
            defaultValue={major(a.offerAutoDeclineBelowIlsMinor)}
          />
          <ShowOnError code="PRICE_CONFIRM_REQUIRED">
            <FormCheckbox
              name="confirmPriceChange"
              label={t("fields.confirmPriceChange")}
              hint={t("fields.confirmPriceChangeHint")}
            />
          </ShowOnError>
        </ActionForm>
      </Section>

      <Section id="shipping" title={t("editor.shipping")}>
        <ActionForm
          action={updateShippingAction}
          locale={locale}
          hidden={hidden}
          errorNamespace={err}
          testId="shipping-form"
          {...save}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="packagingType"
              label={t("fields.packagingType")}
              type="select"
              defaultValue={a.packagingType}
              options={PACKAGING_TYPES.map((p) => ({
                value: p,
                label: t(`packaging.${p}`),
              }))}
            />
            <FormField
              name="sizeClassOverride"
              label={t("fields.sizeClassOverride")}
              type="select"
              defaultValue={a.sizeClassOverride ?? ""}
              placeholder={t("fields.sizeClassAuto")}
              options={(["S", "M", "L", "QUOTE"] as const).map((c) => ({
                value: c,
                label: c,
              }))}
            />
          </div>
          <FormCheckbox
            name="canBeRolled"
            label={t("fields.canBeRolled")}
            defaultChecked={a.canBeRolled}
          />
          <div className="grid gap-4 sm:grid-cols-4">
            <FormField
              name="packedLengthCm"
              label={t("fields.packedLengthCm")}
              type="number"
              defaultValue={cm(a.packedLengthMm)}
            />
            <FormField
              name="packedWidthCm"
              label={t("fields.packedWidthCm")}
              type="number"
              defaultValue={cm(a.packedWidthMm)}
            />
            <FormField
              name="packedHeightCm"
              label={t("fields.packedHeightCm")}
              type="number"
              defaultValue={cm(a.packedHeightMm)}
            />
            <FormField
              name="packedWeightKg"
              label={t("fields.packedWeightKg")}
              type="number"
              defaultValue={kg(a.packedWeightG)}
            />
          </div>
          <div>
            <UseSuggestionButton
              label={t("fields.useSuggestion", {
                length: cm(suggestion.lengthMm),
                width: cm(suggestion.widthMm),
                height: cm(suggestion.heightMm),
                weight: kg(suggestion.weightG),
              })}
              values={{
                packedLengthCm: cm(suggestion.lengthMm),
                packedWidthCm: cm(suggestion.widthMm),
                packedHeightCm: cm(suggestion.heightMm),
                packedWeightKg: kg(suggestion.weightG),
              }}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <FormCheckbox
              name="shipsInternationally"
              label={t("fields.shipsInternationally")}
              defaultChecked={a.shipsInternationally}
            />
            <FormCheckbox
              name="localPickupOnly"
              label={t("fields.localPickupOnly")}
              defaultChecked={a.localPickupOnly}
            />
            <FormCheckbox
              name="quoteOnly"
              label={t("fields.quoteOnly")}
              defaultChecked={a.quoteOnly}
            />
          </div>
          <FormField
            name="dispatchDays"
            label={t("fields.dispatchDays")}
            type="number"
            inputMode="numeric"
            defaultValue={a.dispatchDays}
          />
        </ActionForm>
        <div
          className="flex flex-col gap-2 border-t border-line pbs-3 text-sm"
          data-testid="shipping-class"
        >
          <p className="font-medium">
            {t("shipping.class", {
              class: detail.shipping.classified.sizeClass,
            })}{" "}
            ·{" "}
            {t("shipping.chargeable", {
              kg: (detail.shipping.classified.chargeableG / 1000).toFixed(2),
            })}
          </p>
          {detail.shipping.classified.reasons.length > 0 ? (
            <p className="text-ink-muted">
              {t("shipping.reasons", {
                reasons: detail.shipping.classified.reasons.join(", "),
              })}
            </p>
          ) : null}
          {detail.shipping.usesDefaults ? (
            <p className="text-ink-muted">{t("shipping.defaults")}</p>
          ) : null}
          <h3 className="font-sans font-semibold">{t("shipping.estimates")}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {ZONE_IDS.map((z) => {
              const e = detail.shipping.estimates[z];
              return (
                <div key={z} className="contents">
                  <dt>{t(`zone.${z}`)}</dt>
                  <dd>
                    {e === "QUOTE" ? (
                      t("shipping.quote")
                    ) : e === "UNAVAILABLE" ? (
                      t("shipping.unavailable")
                    ) : (
                      <>
                        {t("shipping.from", { price: "" })}
                        <Price
                          amountMinor={e.fromIlsMinor}
                          currency="ILS"
                          locale={locale}
                        />
                        {e.insured ? ` · ${t("shipping.insured")}` : ""}
                      </>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      </Section>

      <Section id="customs" title={t("editor.customs")}>
        <ActionForm
          action={updateCustomsAction}
          locale={locale}
          hidden={hidden}
          errorNamespace={err}
          testId="customs-form"
          {...save}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="hsCode"
              label={t("fields.hsCode")}
              defaultValue={a.hsCode}
              dir="ltr"
            />
            <FormField
              name="countryOfOrigin"
              label={t("fields.countryOfOrigin")}
              defaultValue={a.countryOfOrigin}
              dir="ltr"
            />
          </div>
          <FormField
            name="customsDescriptionEn"
            label={t("fields.customsDescriptionEn")}
            hint={t("fields.customsDescriptionHint")}
            defaultValue={a.customsDescriptionEn}
            dir="ltr"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="declaredValueOverrideIls"
              label={t("fields.declaredValueOverrideIls")}
              hint={t("fields.declaredValueHint")}
              type="number"
              defaultValue={major(a.declaredValueOverrideMinor)}
            />
            <FormField
              name="maxInsurableValueIls"
              label={t("fields.maxInsurableValueIls")}
              type="number"
              defaultValue={major(a.maxInsurableValueMinor)}
            />
          </div>
          <FormField
            name="creditLine"
            label={t("fields.creditLine")}
            defaultValue={a.creditLine}
          />
        </ActionForm>
      </Section>

      {a.publishedAt === null && a.saleStatus !== "SOLD" ? (
        <Section id="delete" title={t("editor.danger")}>
          <ActionForm
            action={deleteDraftAction}
            locale={locale}
            hidden={hidden}
            submitLabel={t("editor.deleteDraft")}
            submitVariant="danger"
            errorNamespace={err}
            confirm={{
              title: t("editor.deleteDraft"),
              message: t("editor.deleteDraftConfirm"),
              confirmLabel: t("editor.deleteDraft"),
            }}
          />
        </Section>
      ) : null}
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<"admin-catalog">>>;

function SaleActions({
  locale,
  status,
  hidden,
  overrideHidden,
  override,
  t,
  err,
}: {
  locale: Locale;
  status: "AVAILABLE" | "ON_HOLD" | "SOLD" | "NOT_FOR_SALE";
  hidden: Record<string, string>;
  overrideHidden: Record<string, string>;
  override?: { title: string; message: string; confirmLabel: string };
  t: T;
  err: string;
}) {
  const today = jerusalemDateKey(new Date());
  const hold =
    status === "AVAILABLE" ? (
      <div className="flex flex-col gap-2" data-testid="offline-hold">
        <h3 className="font-sans font-semibold">{t("sale.hold")}</h3>
        <p className="text-sm text-ink-muted">{t("sale.holdIntro")}</p>
        <ActionForm
          action={offlineHoldAction}
          locale={locale}
          hidden={overrideHidden}
          submitLabel={t("sale.holdSubmit")}
          submitVariant="secondary"
          successText={t("sale.holdDone")}
          errorNamespace={err}
          confirm={override}
          testId="offline-hold-form"
        >
          <FormField
            name="reason"
            label={t("sale.reason")}
            type="select"
            defaultValue="RESERVED_OFFLINE"
            options={HOLD_REASONS.map((r) => ({
              value: r,
              label: t(`holdReason.${r}`),
            }))}
          />
          <FormField name="note" label={t("sale.note")} />
        </ActionForm>
      </div>
    ) : null;
  const sold =
    status === "AVAILABLE" || status === "ON_HOLD" ? (
      <div className="flex flex-col gap-2" data-testid="sold-offline">
        <h3 className="font-sans font-semibold">{t("sale.sold")}</h3>
        <p className="text-sm text-ink-muted">{t("sale.soldIntro")}</p>
        <ActionForm
          action={soldOfflineAction}
          locale={locale}
          hidden={overrideHidden}
          submitLabel={t("sale.soldSubmit")}
          submitVariant="secondary"
          successText={t("sale.soldDone")}
          errorNamespace={err}
          confirm={
            override ?? {
              title: t("sale.sold"),
              message: t("sale.soldConfirm"),
              confirmLabel: t("sale.soldSubmit"),
            }
          }
          testId="sold-offline-form"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              name="soldOn"
              label={t("sale.soldOnLabel")}
              type="date"
              defaultValue={today}
              required
            />
            <FormField
              name="price"
              label={t("sale.salePrice")}
              hint={t("sale.salePriceHint")}
              type="number"
            />
            <FormField
              name="currency"
              label={t("sale.currency")}
              type="select"
              defaultValue="ILS"
              options={[
                { value: "ILS", label: "ILS ₪" },
                { value: "USD", label: "USD $" },
              ]}
            />
          </div>
          <FormField name="note" label={t("sale.note")} />
        </ActionForm>
      </div>
    ) : null;
  return (
    <div className="flex flex-col gap-6">
      {hold}
      {status === "ON_HOLD" ? (
        <ActionForm
          action={releaseHoldAction}
          locale={locale}
          hidden={hidden}
          submitLabel={t("sale.release")}
          submitVariant="secondary"
          successText={t("sale.releaseDone")}
          errorNamespace={err}
          testId="release-hold-form"
        />
      ) : null}
      {sold}
      {status === "AVAILABLE" || status === "ON_HOLD" ? (
        <div className="flex flex-col gap-2">
          <h3 className="font-sans font-semibold">{t("sale.notForSale")}</h3>
          <p className="text-sm text-ink-muted">{t("sale.notForSaleIntro")}</p>
          <ActionForm
            action={notForSaleAction}
            locale={locale}
            hidden={overrideHidden}
            submitLabel={t("sale.notForSaleSubmit")}
            submitVariant="ghost"
            successText={t("sale.notForSaleDone")}
            errorNamespace={err}
            confirm={override}
          />
        </div>
      ) : null}
      {status === "NOT_FOR_SALE" ? (
        <ActionForm
          action={forSaleAction}
          locale={locale}
          hidden={hidden}
          submitLabel={t("sale.forSale")}
          submitVariant="secondary"
          successText={t("sale.forSaleDone")}
          errorNamespace={err}
        />
      ) : null}
      {status === "SOLD" ? (
        <>
          <div className="flex flex-col gap-2" data-testid="relist">
            <h3 className="font-sans font-semibold">{t("sale.relist")}</h3>
            <p className="text-sm text-ink-muted">{t("sale.relistIntro")}</p>
            <ActionForm
              action={relistAction}
              locale={locale}
              hidden={{ ...hidden, confirm: "on" }}
              submitLabel={t("sale.relistSubmit")}
              submitVariant="secondary"
              successText={t("sale.relistDone")}
              errorNamespace={err}
              confirm={{
                title: t("sale.relist"),
                message: t("sale.relistConfirm"),
                confirmLabel: t("sale.relistSubmit"),
              }}
            >
              <FormField name="reason" label={t("sale.reasonText")} />
            </ActionForm>
          </div>
          <ActionForm
            action={damagedAction}
            locale={locale}
            hidden={{ ...hidden, confirm: "on" }}
            submitLabel={t("sale.damagedSubmit")}
            submitVariant="ghost"
            successText={t("sale.damagedDone")}
            errorNamespace={err}
            confirm={{
              title: t("sale.damaged"),
              message: t("sale.damagedConfirm"),
              confirmLabel: t("sale.damagedSubmit"),
            }}
          />
        </>
      ) : null}
    </div>
  );
}
