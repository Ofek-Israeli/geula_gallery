import { useLocale, useTranslations } from "next-intl";
import { buttonClasses } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { Link } from "@/i18n/navigation";
import type { ArtworkDetailDTO, ZoneEstimateDTO } from "@/lib/catalog";
import type { Locale } from "@/lib/locale";
import { formatMoney } from "@/lib/money";
import { paths } from "@/lib/routes";
import { useStatusText } from "./ArtworkStatus";
import { shownPriceMinor, trustItems, zoneIsInsured } from "./buy-box";

export const BUY_BOX_ID = "buy-box";

/**
 * The live buy box (spec §6.3). Rendered per request from the DB (never cached):
 * - the ILS price for an available work (also while another buyer is checking out), and the
 *   status in text;
 * - Buy now (→ checkout) when buyable; Ask; sold works offer "similar works" and "commission";
 * - "Delivery in Israel from ₪X · free studio pickup" and per-zone estimates, linking to the
 *   shipping page; the DAP note;
 * - the trust row, with "insured" only when the cheapest Israeli quote includes insurance.
 */
export function LiveBuyBox({
  artwork,
  estimates,
  pickupFree,
}: {
  artwork: ArtworkDetailDTO;
  estimates: ZoneEstimateDTO[];
  pickupFree: boolean;
}) {
  const t = useTranslations("artwork");
  const locale = useLocale() as Locale;
  const statusText = useStatusText();
  const { state, price, slug } = artwork;
  const available = state.kind === "available";
  const buyable = available && state.buyable;
  const israel = estimates.find((e) => e.zone === "IL");
  const israelPrice = israel?.kind === "price" ? israel : null;
  const ask = paths.artworkRequest(slug, "question");
  const shownPrice = shownPriceMinor(artwork);

  return (
    <section
      id={BUY_BOX_ID}
      aria-labelledby="buy-box-title"
      className="flex flex-col gap-5 border border-line bg-paper p-5"
      data-testid="buy-box"
    >
      <h2 id="buy-box-title" className="sr-only">
        {t("buy.label")}
      </h2>

      <div className="flex flex-col gap-1">
        {shownPrice !== null ? (
          <p className="text-3xl" data-testid="artwork-price">
            <Price amountMinor={shownPrice} currency="ILS" locale={locale} />
          </p>
        ) : null}
        {available && (price.onRequest || price.ilsMinor === null) ? (
          <p className="text-xl">{t("buy.priceOnRequest")}</p>
        ) : null}
        <p
          className={shownPrice !== null ? "text-ink-muted" : "text-xl"}
          data-testid="artwork-status"
        >
          {state.kind === "sold" ? (
            <span
              aria-hidden="true"
              className="me-2 inline-block size-2.5 rounded-full bg-reddot"
            />
          ) : null}
          {statusText(state)}
        </p>
        {artwork.quoteOnly && available ? (
          <p className="text-sm text-ink-muted">{t("buy.quoteOnly")}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        {buyable ? (
          <Link
            href={paths.checkout(slug)}
            className={buttonClasses("primary")}
            data-testid="buy-now"
          >
            {t("buy.buyNow")}
          </Link>
        ) : null}
        {available && artwork.quoteOnly ? (
          <Link
            href={paths.artworkRequest(slug, "quote")}
            className={buttonClasses("primary")}
          >
            {t("buy.requestQuote")}
          </Link>
        ) : null}
        {state.kind === "sold" ? (
          <>
            <Link
              href={paths.artworkRequest(slug, "question")}
              className={buttonClasses("secondary")}
            >
              {t("buy.askSimilar")}
            </Link>
            <Link
              href={paths.contact("commission")}
              className={buttonClasses("ghost")}
            >
              {t("buy.commission")}
            </Link>
          </>
        ) : (
          <Link href={ask} className={buttonClasses("secondary")}>
            {t("buy.ask")}
          </Link>
        )}
        {locale === "en" && price.usdMinor !== null && available ? (
          <p className="text-sm text-ink-muted">{t("buy.usdAbroad")}</p>
        ) : null}
      </div>

      {available || state.kind === "reserved" ? (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 className="font-medium">{t("delivery.title")}</h3>
          {israelPrice ? (
            <p>
              <Link href={paths.legal("shipping")}>
                {t("delivery.israelFrom", {
                  price: formatMoney(israelPrice.fromIlsMinor, "ILS", locale),
                })}
              </Link>
              {pickupFree ? <> · {t("delivery.freePickup")}</> : null}
            </p>
          ) : null}
          <dl
            aria-label={t("delivery.zonesLabel")}
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
          >
            {estimates.map((e) => (
              <div key={e.zone} className="contents">
                <dt className="text-ink-muted">
                  {t(`delivery.zone.${e.zone}`)}
                </dt>
                <dd>
                  {e.kind === "price" ? (
                    <>
                      {t("delivery.from", {
                        price: formatMoney(e.fromIlsMinor, "ILS", locale),
                      })}
                      {zoneIsInsured(e) ? (
                        <> · {t("delivery.insured")}</>
                      ) : null}
                      {e.estimate ? (
                        <span className="text-ink-muted"> · {e.estimate}</span>
                      ) : null}
                    </>
                  ) : e.kind === "quote" ? (
                    t("delivery.quote")
                  ) : (
                    t("delivery.unavailable")
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-ink-muted">{t("delivery.dap")}</p>
          <p className="text-sm">
            <Link href={paths.legal("shipping")}>{t("delivery.details")}</Link>
          </p>
        </div>
      ) : null}

      <ul
        aria-label={t("trust.label")}
        className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-4 text-sm text-ink-muted"
        data-testid="trust-row"
      >
        {trustItems(estimates, artwork.coaIncluded).map((item, i) => (
          <li key={item}>
            {i > 0 ? <span aria-hidden="true">· </span> : null}
            {t(`trust.${item}`)}
          </li>
        ))}
      </ul>
    </section>
  );
}
