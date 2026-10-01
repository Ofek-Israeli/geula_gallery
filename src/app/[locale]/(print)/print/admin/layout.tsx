import { isLocale } from "@/lib/locale";
import { requireAdmin } from "@/server/next/guards";

/**
 * Admin printables (packing slip, commercial invoice, COA, studio notice). requireAdmin runs here
 * AND in every page below (spec §1.1.7, §2.1): a layout guard alone is never enough.
 */
export default async function PrintAdminLayout({
  children,
  params,
}: LayoutProps<"/[locale]/print/admin">) {
  const { locale } = await params;
  await requireAdmin({ locale: isLocale(locale) ? locale : undefined });
  return children;
}
