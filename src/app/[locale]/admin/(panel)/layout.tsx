import { AdminBottomTabs, AdminSideNav } from "@/components/admin/AdminNav";
import { SkipLink } from "@/components/ui/SkipLink";
import { isLocale } from "@/lib/locale";
import { navBadges } from "@/server/admin/dashboard";
import { requireAdmin } from "@/server/next/guards";

/**
 * Admin panel shell. `requireAdmin` runs here AND at the top of every page below (spec §1.1.7):
 * layouts do not re-run on client navigation, so the layout guard alone is never enough.
 */
export default async function AdminPanelLayout({
  children,
  params,
}: LayoutProps<"/[locale]/admin">) {
  const { locale: raw } = await params;
  const locale = isLocale(raw) ? raw : "he";
  const ctx = await requireAdmin({ locale });
  const badges = await navBadges(ctx);
  return (
    <div className="flex min-h-dvh flex-1 flex-col md:flex-row">
      <SkipLink />
      <AdminSideNav
        locale={locale}
        userName={ctx.name || ctx.email}
        badges={badges}
      />
      <main
        id="main"
        tabIndex={-1}
        className="w-full flex-1 px-4 pbs-6 pbe-24 focus:outline-none md:px-8 md:pbe-10"
      >
        {children}
      </main>
      <AdminBottomTabs badges={badges} />
    </div>
  );
}
