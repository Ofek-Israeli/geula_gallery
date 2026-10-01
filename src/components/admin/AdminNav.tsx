import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/locale";
import { SignOutButton } from "./SignOutButton";

/**
 * Admin navigation (spec §6.10): a side nav on the start side on desktop, bottom tabs on mobile
 * (לוח בקרה / יצירות / הזמנות / הודעות / עוד) with badges, and the "+ יצירה חדשה" button.
 */
export interface NavBadges {
  inbox: number;
  orders: number;
  alerts: number;
}

const PRIMARY = [
  { href: "/admin", key: "dashboard" },
  { href: "/admin/artworks", key: "artworks" },
  { href: "/admin/orders", key: "orders", badge: "orders" },
  { href: "/admin/inbox", key: "inbox", badge: "inbox" },
] as const;

export const SECONDARY = [
  { href: "/admin/cancellations", key: "cancellations" },
  { href: "/admin/alerts", key: "alerts", badge: "alerts" },
  { href: "/admin/settings", key: "settings" },
  { href: "/admin/account", key: "account" },
] as const;

const itemClass =
  "flex min-h-11 items-center justify-between gap-2 rounded-sm px-3 no-underline hover:bg-paper";

function Count({ n, label }: { n: number; label: string }) {
  if (n <= 0) return null;
  return (
    <span className="min-w-6 rounded-full bg-reddot px-1.5 text-center text-xs leading-5 text-paper">
      <span aria-hidden="true">{n > 99 ? "99+" : n}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function AdminSideNav({
  locale,
  userName,
  badges,
}: {
  locale: Locale;
  userName: string;
  badges: NavBadges;
}) {
  const t = useTranslations("admin-shell.nav");
  return (
    <nav
      aria-label={t("label")}
      className="hidden w-60 shrink-0 flex-col gap-1 border-e border-line bg-wall p-3 md:flex"
    >
      <Link
        href="/admin/artworks/new"
        className="mbe-2 flex min-h-11 items-center justify-center rounded-sm border border-ink bg-ink px-3 text-paper no-underline"
      >
        {t("newArtwork")}
      </Link>
      <ul className="flex flex-col gap-1">
        {[...PRIMARY, ...SECONDARY].map((item) => (
          <li key={item.key}>
            <Link href={item.href} className={itemClass}>
              <span>{t(item.key)}</span>
              {"badge" in item ? (
                <Count
                  n={badges[item.badge]}
                  label={t("badge", { count: badges[item.badge] })}
                />
              ) : null}
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

export function AdminBottomTabs({ badges }: { badges: NavBadges }) {
  const t = useTranslations("admin-shell.nav");
  return (
    <nav
      aria-label={t("label")}
      className="pbe-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper md:hidden"
    >
      <ul className="grid grid-cols-5">
        {[
          ...PRIMARY,
          { href: "/admin/more", key: "more", badge: "alerts" } as const,
        ].map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className="relative flex min-h-12 flex-col items-center justify-center px-1 text-center text-sm no-underline"
            >
              <span>{t(item.key)}</span>
              {"badge" in item ? (
                <Count
                  n={badges[item.badge]}
                  label={t("badge", { count: badges[item.badge] })}
                />
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
