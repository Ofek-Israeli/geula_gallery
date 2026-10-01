import { useTranslations } from "next-intl";
import type { Locale } from "@/lib/locale";

/** `+972-3-000-0000` → `972300000000` for `tel:` and `wa.me` links. */
export function phoneDigits(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

/**
 * Email and phone for the contact page (spec §6.2): values in `<bdi dir="ltr">`, never mirrored
 * (spec §6.4). The email link carries a subject in the page language; Hebrew pages show the local
 * phone format, English pages the international one.
 */
export function ContactDetails({
  email,
  phoneIntl,
  phoneLocal,
  subject,
  locale,
}: {
  email: string;
  phoneIntl: string;
  phoneLocal: string;
  subject: string;
  locale: Locale;
}) {
  const t = useTranslations("catalog.contact");
  const digits = phoneDigits(phoneIntl);
  const shownPhone = locale === "he" ? phoneLocal : phoneIntl;
  const rows = [
    {
      label: t("email"),
      href: `mailto:${email}?subject=${encodeURIComponent(subject)}`,
      value: email,
    },
    { label: t("phone"), href: `tel:+${digits}`, value: shownPhone },
    { label: t("whatsapp"), href: `https://wa.me/${digits}`, value: phoneIntl },
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
    </dl>
  );
}
