import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { buttonClasses } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { Link } from "@/i18n/navigation";
import { LOCALE_FIELD } from "@/lib/forms";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { type CartLine, loadCart } from "@/server/cart/cart";
import { env } from "@/server/env";
import { readCartIds } from "@/server/next/cart";
import { removeFromCartAction } from "./actions";

/**
 * `/[locale]/cart` (noindex): the works collected for one checkout, re-read live on every request.
 * Ready works (available and buyable) go to the checkout together; the others are listed with the
 * reason and a Remove button. Nothing is reserved until "Continue to payment" at the checkout.
 * While online sales are closed (`SALES_OPEN=false`) it only says so.
 */
export async function generateMetadata({
  params,
}: PageProps<"/[locale]/cart">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "checkout.cart" });
  return { title: t("title"), robots: { index: false, follow: false } };
}

const NOTICES = new Set(["removed", "restored"]);

export default async function CartPage({
  params,
  searchParams,
}: PageProps<"/[locale]/cart">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const noticeParam = Array.isArray(sp.cart) ? sp.cart[0] : sp.cart;
  const notice = noticeParam && NOTICES.has(noticeParam) ? noticeParam : null;
  const t = await getTranslations({ locale, namespace: "checkout.cart" });
  if (!env.SALES_OPEN) {
    return (
      <div className="flex max-w-3xl flex-col gap-8">
        <h1 className="text-4xl">{t("title")}</h1>
        <div
          className="flex flex-col items-start gap-4"
          data-testid="cart-sales-closed"
        >
          <p>{t("salesClosed")}</p>
          <Link href={paths.works()} className={buttonClasses("secondary")}>
            {t("emptyCta")}
          </Link>
        </div>
      </div>
    );
  }
  const cart = await loadCart(locale, await readCartIds());
  const ready = cart.lines.filter((l) => l.readiness === "ready");
  const other = cart.lines.filter((l) => l.readiness !== "ready");
  const subtotal = ready.reduce(
    (sum, l) => sum + (l.work.price.ilsMinor ?? 0),
    0,
  );

  const removeForm = (l: CartLine) => (
    <form action={removeFromCartAction}>
      <input type="hidden" name={LOCALE_FIELD} value={locale} />
      <input type="hidden" name="artworkId" value={l.work.id} />
      <button
        type="submit"
        className={buttonClasses("ghost", "sm")}
        aria-label={t("removeLabel", { title: l.work.title })}
        data-testid="cart-remove"
      >
        {t("remove")}
      </button>
    </form>
  );

  const line = (l: CartLine, status?: string) => (
    <li
      key={l.work.id}
      className="flex items-center gap-4 border-b border-line py-4"
      data-testid="cart-line"
      data-slug={l.work.slug}
    >
      {l.work.image ? (
        <Image
          src={l.work.image.src}
          alt={l.work.image.alt}
          width={l.work.image.width}
          height={l.work.image.height}
          sizes="96px"
          className="h-24 w-24 shrink-0 object-contain"
        />
      ) : null}
      <div className="flex min-w-0 grow flex-col gap-1">
        <Link href={paths.artwork(l.work.slug)} className="font-serif text-lg">
          {l.work.title}
        </Link>
        {l.work.mediumText ? (
          <span className="text-sm text-ink-muted">{l.work.mediumText}</span>
        ) : null}
        {status ? (
          <span className="text-sm" data-testid="cart-line-status">
            {status}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {l.readiness === "ready" && l.work.price.ilsMinor !== null ? (
          <Price
            amountMinor={l.work.price.ilsMinor}
            currency="ILS"
            locale={locale}
          />
        ) : null}
        {removeForm(l)}
      </div>
    </li>
  );

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <h1 className="text-4xl">{t("title")}</h1>
      {notice ? (
        <p
          role="status"
          className="border border-line p-3"
          data-testid="cart-notice"
        >
          {t(`notice.${notice as "removed" | "restored"}`)}
        </p>
      ) : null}

      {cart.lines.length === 0 ? (
        <div
          className="flex flex-col items-start gap-4"
          data-testid="cart-empty"
        >
          <p>{t("empty")}</p>
          <Link href={paths.works()} className={buttonClasses("secondary")}>
            {t("emptyCta")}
          </Link>
        </div>
      ) : (
        <>
          {ready.length > 0 ? (
            <section
              aria-labelledby="cart-ready"
              className="flex flex-col gap-4"
            >
              <h2 id="cart-ready" className="text-2xl">
                {t("count", { count: ready.length })}
              </h2>
              <ul className="flex flex-col">{ready.map((l) => line(l))}</ul>
              <dl className="grid grid-cols-[1fr_auto] gap-x-6">
                <dt className="font-semibold">{t("subtotal")}</dt>
                <dd className="font-semibold" data-testid="cart-subtotal">
                  <Price
                    amountMinor={subtotal}
                    currency="ILS"
                    locale={locale}
                  />
                </dd>
              </dl>
              <p className="text-sm text-ink-muted">
                {t("shippingAtCheckout")}
              </p>
              <p className="text-sm text-ink-muted">{t("notReserved")}</p>
              <div>
                <Link
                  href={paths.cartCheckout()}
                  className={buttonClasses("primary")}
                  data-testid="cart-checkout"
                >
                  {t("checkout")}
                </Link>
              </div>
            </section>
          ) : null}
          {other.length > 0 ? (
            <section
              aria-labelledby="cart-unavailable"
              className="flex flex-col gap-4"
            >
              <h2 id="cart-unavailable" className="text-2xl">
                {t("unavailableTitle")}
              </h2>
              <ul className="flex flex-col">
                {other.map((l) =>
                  line(
                    l,
                    t(
                      `status.${l.readiness as Exclude<CartLine["readiness"], "ready">}`,
                    ),
                  ),
                )}
              </ul>
            </section>
          ) : null}
          <p className="text-sm text-ink-muted">
            {t("limit", { max: cart.maxItems })}
          </p>
        </>
      )}
    </div>
  );
}
