import { useTranslations } from "next-intl";
import type { Locale } from "@/lib/locale";

/** `+972-3-000-0000` → `972300000000` for `tel:` and `wa.me` links. */
export function phoneDigits(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

/**
 * Email, phone and address for the contact page (spec §6.2): email and phone in `<bdi dir="ltr">`,
 * never mirrored (spec §6.4). The email link carries a subject in the page language; Hebrew pages
 * show the local phone format, English pages the international one. No email row when the business
 * has no public email (visitors use the contact form). The address row ends with the country
 * (Isracard's form: "full address, country and phone"); no row when the address is empty.
 */
export function ContactDetails({
  email,
  phoneIntl,
  phoneLocal,
  address,
  subject,
  locale,
}: {
  email: string;
  phoneIntl: string;
  phoneLocal: string;
  address: string;
  subject: string;
  locale: Locale;
}) {
  const t = useTranslations("catalog.contact");
  const digits = phoneDigits(phoneIntl);
  const shownPhone = locale === "he" ? phoneLocal : phoneIntl;
  const rows = [
    ...(email
      ? [
          {
            label: t("email"),
            href: `mailto:${email}?subject=${encodeURIComponent(subject)}`,
            value: email,
          },
        ]
      : []),
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-ink-muted">{r.label}</dt>
          <dd>
            <a
              href={r.href}
              className="inline-flex min-h-6 items-center underline"
              {...(r.href.startsWith("https:")
                ? { rel: "noopener noreferrer" }
                : {})}
            >
              <bdi dir="ltr">{r.value}</bdi>
            </a>
          </dd>
        </div>
      ))}
      {/* One number for calls and WhatsApp. */}
      <div className="contents">
        <dt className="text-ink-muted">{t("phoneWhatsapp")}</dt>
        <dd className="flex flex-wrap items-center gap-x-3">
          <a
            href={`tel:+${digits}`}
            className="inline-flex min-h-6 items-center underline"
          >
            <bdi dir="ltr">{shownPhone}</bdi>
          </a>
          <a
            href={`https://wa.me/${digits}`}
            rel="noopener noreferrer"
            className="inline-flex min-h-6 items-center underline"
          >
            {t("whatsapp")}
          </a>
        </dd>
      </div>
      {address.trim() ? (
        <div className="contents">
          <dt className="text-ink-muted">{t("address")}</dt>
          <dd data-testid="contact-address">
            {t("addressWithCountry", { address: address.trim() })}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
