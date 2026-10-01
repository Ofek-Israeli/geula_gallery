import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isLocale } from "@/lib/locale";
import { requireAdmin } from "@/server/next/guards";
import { getSetting } from "@/server/settings";
import { AdminActionForm } from "../../cancellations/AdminActionForm";
import { saveCancellationPolicyAction } from "./actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/settings/cancellation">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "cancel.settings" });
  return { title: t("title") };
}

/**
 * `/admin/settings/cancellation` (spec §4.7, §6.10): the change-of-mind fee policy. The fee is a
 * suggestion; each decision may only lower it.
 */
export default async function CancellationSettingsPage({
  params,
}: PageProps<"/[locale]/admin/settings/cancellation">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireAdmin({ locale });
  const [t, policy] = await Promise.all([
    getTranslations({ locale, namespace: "cancel.settings" }),
    getSetting("cancellation_policy"),
  ]);
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-3xl">{t("title")}</h1>
      <p className="text-ink-muted">{t("intro")}</p>
      <AdminActionForm
        action={saveCancellationPolicyAction}
        locale={locale}
        submitLabel={t("save")}
        variant="primary"
        testId="cancellation-policy"
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mbe-2 font-medium">{t("feeLabel")}</legend>
          {(["STATUTORY_MAX", "NONE"] as const).map((v) => (
            <label key={v} className="flex items-center gap-3">
              <input
                type="radio"
                name="changeOfMindFee"
                value={v}
                defaultChecked={policy.changeOfMindFee === v}
                className="size-5 accent-ink"
              />
              {t(v)}
            </label>
          ))}
        </fieldset>
      </AdminActionForm>
    </div>
  );
}
