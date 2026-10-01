import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/locale";
import { SignOutButton } from "./SignOutButton";

/**
 * Admin navigation (spec §6.10): a side nav on the start side on desktop, bottom tabs on mobile
 * (לוח בקרה / יצירות / הזמנות / הודעות / עוד). M1 minimal version; WS4 adds badges and the
 * "+ יצירה חדשה" button behaviour.
 */
const PRIMARY = [
  { href: "/admin", key: "dashboard" },
  { href: "/admin/artworks", key: "artworks" },
  { href: "/admin/orders", key: "orders" },
  { href: "/admin/inbox", key: "inbox" },
] as const;

const SECONDARY = [
  { href: "/admin/cancellations", key: "cancellations" },
  { href: "/admin/alerts", key: "alerts" },
  { href: "/admin/settings", key: "settings" },
  { href: "/admin/account", key: "account" },
] as const;

const itemClass =
  "flex min-h-11 items-center rounded-sm px-3 no-underline hover:bg-paper";

export function AdminSideNav({
  locale,
  userName,
}: {
  locale: Locale;
  userName: string;
}) {
  const t = useTranslations("admin-shell.nav");
  return (
    <nav
      aria-label={t("label")}
      className="hidden w-60 shrink-0 flex-col gap-1 border-e border-line bg-wall p-3 md:flex"
    >
      <ul className="flex flex-col gap-1">
        {[...PRIMARY, ...SECONDARY].map((item) => (
          <li key={item.key}>
            <Link href={item.href} className={itemClass}>
              {t(item.key)}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mbs-auto flex flex-col gap-2 border-t border-line pbs-3 text-sm">
        <span className="px-3 text-ink-muted">{userName}</span>
        <Link href="/" className={itemClass}>
          {t("viewSite")}
        </Link>
        <SignOutButton locale={locale} label={t("signOut")} />
      </div>
    </nav>
  );
}

export function AdminBottomTabs() {
  const t = useTranslations("admin-shell.nav");
  return (
    <nav
      aria-label={t("label")}
      className="pbe-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper md:hidden"
    >
      <ul className="grid grid-cols-5">
        {[...PRIMARY, { href: "/admin/more", key: "more" } as const].map(
          (item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="flex min-h-12 items-center justify-center px-1 text-center text-sm no-underline"
              >
                {t(item.key)}
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
