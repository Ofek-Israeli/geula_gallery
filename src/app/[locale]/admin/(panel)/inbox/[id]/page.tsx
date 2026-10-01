import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActionForm, FormField } from "@/components/admin/forms";
import { ReplyTemplatePicker } from "@/components/admin/ReplyTemplatePicker";
import { Badge } from "@/components/ui/Badge";
import { Price } from "@/components/ui/Price";
import { Link } from "@/i18n/navigation";
import { countryName, countryOptions } from "@/lib/countries";
import { formatDateTime } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { toDecimalString } from "@/lib/money";
import { paths } from "@/lib/routes";
import { requireAdmin } from "@/server/next/guards";
import { getRequest } from "@/server/requests/service";
import { getSetting } from "@/server/settings";
import {
  acceptOfferAction,
  closeAction,
  counterOfferAction,
  declineAction,
  replyAction,
  sendQuoteAction,
} from "../actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/inbox/[id]">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-shell.inbox" });
  return { title: t("title") };
}

const TEMPLATES = ["available", "sold", "quoteSoon", "moreDetails"] as const;

/**
 * `/admin/inbox/[id]` (spec §6.10, §5.8): the request, the conversation history of that address,
 * a templated reply (emailed in the buyer's language), decline / close, and for a new quote request
 * "Send quote" → `createLinkOrder({ kind: 'QUOTE' })`.
 */
export default async function RequestDetailPage({
  params,
}: PageProps<"/[locale]/admin/inbox/[id]">) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const ctx = await requireAdmin({ locale });
  const detail = await getRequest(ctx, id);
  if (!detail) notFound();
  const { request: r, artwork, order } = detail;
  const t = await getTranslations({ locale, namespace: "admin-shell.inbox" });
  const tOrders = await getTranslations({ locale, namespace: "admin-orders" });
  const tb = await getTranslations({
    locale: r.locale,
    namespace: "requests.replyTemplates",
  });
  const tl = await getTranslations({ locale, namespace: "common.language" });
  const checkout = await getSetting("checkout");
  const err = "admin-shell.inbox.errors";
  const hidden = { requestId: r.id };
  const title = artwork
    ? locale === "he"
      ? artwork.titleHe
      : artwork.titleEn
    : null;
  const country = r.country ?? "IL";
  const currency =
    country === "IL" ? "ILS" : artwork?.priceUsdMinor ? "USD" : "ILS";
  const listPrice = artwork
    ? currency === "ILS"
      ? artwork.priceIlsMinor
      : artwork.priceUsdMinor
    : null;
  const canAnswerOffer =
    r.kind === "OFFER" &&
    r.status === "NEW" &&
    artwork?.saleStatus === "AVAILABLE";
  const canQuote =
    r.kind === "QUOTE" &&
    r.status === "NEW" &&
    artwork?.saleStatus === "AVAILABLE";

  /** The link-order fields shared by "send quote", "accept" and "counter" (price null = fixed). */
  const linkFields = (o: { currency: "ILS" | "USD"; price: string | null }) => (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="name"
          label={t("buyerName")}
          defaultValue={r.name}
          required
        />
        <FormField
          name="email"
          label={t("buyerEmail")}
          type="email"
          defaultValue={r.email}
          required
        />
        <FormField
          name="phone"
          label={t("buyerPhone")}
          type="tel"
          defaultValue={r.phone}
        />
        <FormField
          name="country"
          label={t("destination")}
          type="select"
          defaultValue={country}
          options={countryOptions(locale).map((c) => ({
            value: c.code,
            label: c.name,
          }))}
          required
        />
        {o.price === null ? null : (
          <>
            <FormField
              name="currency"
              label={t("currency")}
              hint={t("currencyHint")}
              type="select"
              defaultValue={o.currency}
              options={[
                { value: "ILS", label: "ILS ₪" },
                { value: "USD", label: "USD $" },
              ]}
            />
            <FormField
              name="itemPrice"
              label={t("itemPrice")}
              type="number"
              defaultValue={o.price}
              required
            />
          </>
        )}
        <FormField
          name="shippingMethod"
          label={t("shippingMethod")}
          type="select"
          defaultValue="QUOTED"
          options={(
            [
              "QUOTED",
              "CARRIER_TABLE",
              "LOCAL_PICKUP",
              "ARTIST_DELIVERY",
            ] as const
          ).map((m) => ({
            value: m,
            label: t(`methods.${m}`),
          }))}
        />
        <FormField
          name="lockedShipping"
          label={t("lockedShipping")}
          hint={t("lockedShippingHint")}
          type="number"
        />
        <FormField
          name="expiresInHours"
          label={t("expiresInHours")}
          type="number"
          inputMode="numeric"
          defaultValue={checkout.linkHoursDefault}
        />
      </div>
      <FormField
        name="priceChangeReason"
        label={t("priceChangeReason")}
        hint={t("priceChangeHint")}
      />
    </>
  );

  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="request-detail">
      <Link href={paths.admin.inbox()} className="text-sm">
        {t("back")}
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl">
          {t("detailTitle", { kind: t(`kind.${r.kind}`), name: "" })}
          <bdi>{r.name}</bdi>
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={r.status === "NEW" ? "hold" : "neutral"}>
            <span data-testid="request-status">{t(`status.${r.status}`)}</span>
          </Badge>
          <span className="text-sm text-ink-muted">
            {t("received", { date: formatDateTime(r.createdAt, locale) })}
          </span>
        </div>
      </header>

      <section className="flex flex-col gap-2 border border-line p-4">
        <h2 className="text-xl">{t("artwork")}</h2>
        {artwork ? (
          <p>
            <Link href={paths.admin.artwork(artwork.id)}>{title}</Link>
            {listPrice !== null ? (
              <span className="text-sm text-ink-muted">
                {" · "}
                {t("listPrice", { price: "" })}
                <Price
                  amountMinor={listPrice}
                  currency={currency}
                  locale={locale}
                />
              </span>
            ) : null}
          </p>
        ) : (
          <p>{t("noArtwork")}</p>
        )}
        {order ? (
          <p>
            <Link href={paths.admin.order(order.id)}>
              {t("order", {
                number: order.number,
                status: tOrders(`status.${order.status}` as "status.PAID"),
              })}
            </Link>
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 border border-line p-4">
        <h2 className="text-xl">{t("contact")}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-ink-muted">{t("name")}</dt>
          <dd>
            <bdi>{r.name}</bdi>
          </dd>
          <dt className="text-ink-muted">{t("email")}</dt>
          <dd>
            <bdi dir="ltr">{r.email}</bdi>
          </dd>
          <dt className="text-ink-muted">{t("phone")}</dt>
          <dd>
            <bdi dir="ltr">{r.phone ?? "—"}</bdi>
          </dd>
          <dt className="text-ink-muted">{t("country")}</dt>
          <dd>{r.country ? countryName(r.country, locale) : "—"}</dd>
          <dt className="text-ink-muted">{t("language")}</dt>
          <dd>{tl(r.locale)}</dd>
        </dl>
        <h3 className="font-sans font-semibold">{t("message")}</h3>
        <p className="whitespace-pre-wrap" data-testid="request-message">
          <bdi>{r.message || "—"}</bdi>
        </p>
        {r.adminReply ? (
          <>
            <h3 className="font-sans font-semibold">
              {t("lastReply", {
                date: r.repliedAt ? formatDateTime(r.repliedAt, locale) : "",
              })}
            </h3>
            <p className="whitespace-pre-wrap">
              <bdi>{r.adminReply}</bdi>
            </p>
          </>
        ) : null}
      </section>

      {canQuote ? (
        <section
          className="flex flex-col gap-3 border border-line p-4"
          data-testid="send-quote"
        >
          <h2 className="text-xl">{t("quote")}</h2>
          <p className="text-sm text-ink-muted">{t("quoteIntro")}</p>
          <ActionForm
            action={sendQuoteAction}
            locale={locale}
            hidden={hidden}
            submitLabel={t("quoteSubmit")}
            successText={t("quoteSent")}
            errorNamespace={err}
            confirm={{
              title: t("quote"),
              message: t("quoteConfirm"),
              confirmLabel: t("quoteSubmit"),
            }}
            testId="send-quote-form"
          >
            {linkFields({
              currency,
              price: listPrice !== null ? toDecimalString(listPrice) : "",
            })}
          </ActionForm>
        </section>
      ) : null}

      {canAnswerOffer && r.offerAmountMinor && r.offerCurrency ? (
        <section
          className="flex flex-col gap-3 border border-line p-4"
          data-testid="answer-offer"
        >
          <h2 className="text-xl">{t("offer")}</h2>
          <p>
            {t("offerAmount", { amount: "" })}
            <Price
              amountMinor={r.offerAmountMinor}
              currency={r.offerCurrency}
              locale={locale}
            />
          </p>
          <p className="text-sm text-ink-muted">{t("offerIntro")}</p>
          <ActionForm
            action={acceptOfferAction}
            locale={locale}
            hidden={{
              ...hidden,
              itemPrice: toDecimalString(r.offerAmountMinor),
              currency: r.offerCurrency,
            }}
            submitLabel={t("accept")}
            successText={t("offerSent")}
            errorNamespace={err}
            confirm={{
              title: t("accept"),
              message: t("acceptConfirm"),
              confirmLabel: t("accept"),
            }}
            testId="accept-offer-form"
          >
            {linkFields({ currency: r.offerCurrency, price: null })}
          </ActionForm>
          <h3 className="font-sans font-semibold">{t("counter")}</h3>
          <ActionForm
            action={counterOfferAction}
            locale={locale}
            hidden={hidden}
            submitLabel={t("counterSubmit")}
            submitVariant="secondary"
            successText={t("offerSent")}
            errorNamespace={err}
            confirm={{
              title: t("counter"),
              message: t("counterConfirm"),
              confirmLabel: t("counterSubmit"),
            }}
            testId="counter-offer-form"
          >
            {linkFields({
              currency: r.offerCurrency,
              price: listPrice !== null ? toDecimalString(listPrice) : "",
            })}
          </ActionForm>
        </section>
      ) : null}

      <section className="flex flex-col gap-3 border border-line p-4">
        <h2 className="text-xl">{t("reply")}</h2>
        <ActionForm
          action={replyAction}
          locale={locale}
          hidden={hidden}
          submitLabel={t("send")}
          successText={t("sent")}
          errorNamespace={err}
          testId="reply-form"
          resetOnSuccess
        >
          <ReplyTemplatePicker
            label={t("replyTemplate")}
            placeholder={t("replyTemplatePick")}
            target="reply"
            templates={TEMPLATES.map((k) => ({
              key: k,
              label: t(`replyTemplates.${k}`),
              text: tb(k, { name: r.name }),
            }))}
          />
          <FormField
            name="reply"
            label={t("reply")}
            hint={t("replyHint", { language: tl(r.locale) })}
            type="textarea"
            rows={8}
            dir={r.locale === "he" ? "rtl" : "ltr"}
            required
          />
        </ActionForm>
        {r.kind !== "QUESTION" && r.status === "NEW" ? (
          <ActionForm
            action={declineAction}
            locale={locale}
            hidden={hidden}
            submitLabel={t("decline")}
            submitVariant="ghost"
            successText={t("declined")}
            errorNamespace={err}
            confirm={{
              title: t("decline"),
              message: t("declineConfirm"),
              confirmLabel: t("decline"),
            }}
          >
            <FormField
              name="reply"
              label={t("declineHint")}
              type="textarea"
              rows={3}
            />
          </ActionForm>
        ) : null}
        {r.kind === "QUESTION" && r.status === "REPLIED" ? (
          <ActionForm
            action={closeAction}
            locale={locale}
            hidden={hidden}
            submitLabel={t("close")}
            submitVariant="ghost"
            successText={t("closed")}
            errorNamespace={err}
          />
        ) : null}
      </section>

      {detail.history.length > 0 ? (
        <section className="flex flex-col gap-2 border border-line p-4">
          <h2 className="text-xl">{t("history")}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {detail.history.map((h) => (
              <li key={h.id}>
                <Link href={paths.admin.request(h.id)}>
                  {t(`kind.${h.kind}`)} · {t(`status.${h.status}`)} ·{" "}
                  {formatDateTime(h.createdAt, locale)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
