import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ActionForm, FormField } from "@/components/admin/forms";
import { Link } from "@/i18n/navigation";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { ARTWORK_MEDIUMS, ARTWORK_SURFACES } from "@/server/catalog/mutations";
import { requireAdmin } from "@/server/next/guards";
import { createArtworkAction } from "../actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/artworks/new">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "admin-catalog.new" });
  return { title: t("title") };
}

/** `/admin/artworks/new` (spec §6.10): the basics, then the editor. */
export default async function NewArtworkPage({
  params,
}: PageProps<"/[locale]/admin/artworks/new">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireAdmin({ locale });
  const t = await getTranslations({ locale, namespace: "admin-catalog" });
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link href={paths.admin.artworks()} className="text-sm">
        {t("editor.back")}
      </Link>
      <h1 className="text-3xl">{t("new.title")}</h1>
      <p>{t("new.intro")}</p>
      <ActionForm
        action={createArtworkAction}
        locale={locale}
        submitLabel={t("new.submit")}
        errorNamespace="admin-catalog.errors"
        testId="new-artwork-form"
      >
        <FormField name="titleHe" label={t("fields.titleHe")} required />
        <FormField
          name="titleEn"
          label={t("fields.titleEn")}
          required
          dir="ltr"
        />
        <FormField
          name="slug"
          label={t("fields.slug")}
          hint={t("new.slugHint")}
          dir="ltr"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="medium"
            label={t("fields.medium")}
            type="select"
            defaultValue="OIL"
            options={ARTWORK_MEDIUMS.map((m) => ({
              value: m,
              label: t(`medium.${m}`),
            }))}
            required
          />
          <FormField
            name="surface"
            label={t("fields.surface")}
            type="select"
            defaultValue="CANVAS"
            options={ARTWORK_SURFACES.map((s) => ({
              value: s,
              label: t(`surface.${s}`),
            }))}
            required
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            name="heightCm"
            label={t("fields.heightCm")}
            type="number"
            required
          />
          <FormField
            name="widthCm"
            label={t("fields.widthCm")}
            type="number"
            required
          />
          <FormField name="depthCm" label={t("fields.depthCm")} type="number" />
        </div>
      </ActionForm>
    </div>
  );
}
