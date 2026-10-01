import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { Link } from "@/i18n/navigation";
import { jerusalemWallClock } from "@/lib/format";
import { isLocale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import {
  CANCELLATION_CHANNELS,
  CANCELLATION_REASONS,
  ELIGIBLE_GROUPS,
} from "@/server/cancellations/notice";
import { requireAdmin } from "@/server/next/guards";
import { AdminActionForm } from "../AdminActionForm";
import { logNoticeAction } from "../actions";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin/cancellations/new">): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "cancel.admin" });
  return { title: t("newTitle") };
}

/** `datetime-local` value for "now" in Asia/Jerusalem. */
function nowLocal(): string {
  const w = jerusalemWallClock(new Date());
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}`;
}

/**
 * `/admin/cancellations/new` (spec §5.7 step 5): log a notice received by phone, email, registered
 * mail or in person, with the actual receipt time (Asia/Jerusalem). Same never-blocking intake as
 * the web form.
 */
export default async function NewCancellationPage({
  params,
}: PageProps<"/[locale]/admin/cancellations/new">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireAdmin({ locale });
  const [t, tc] = await Promise.all([
    getTranslations({ locale, namespace: "cancel.admin" }),
    getTranslations({ locale, namespace: "cancel" }),
  ]);
  const channels = CANCELLATION_CHANNELS.filter((c) => c !== "WEB");
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link href={paths.admin.cancellations()} className="underline">
        {t("back")}
      </Link>
      <h1 className="text-3xl">{t("newTitle")}</h1>
      <p className="text-ink-muted">{t("newIntro")}</p>
      <AdminActionForm
        action={logNoticeAction}
        locale={locale}
        submitLabel={t("save")}
        variant="primary"
        testId="log-notice"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="ln-channel" label={t("channelLabel")} required>
            {(c) => (
              <Select
                {...c}
                name="channel"
                options={channels.map((ch) => ({
                  value: ch,
                  label: tc(`channel.${ch}`),
                }))}
              />
            )}
          </Field>
          <Field
            id="ln-received"
            label={t("receivedAtLabel")}
            required
            hint="Asia/Jerusalem"
          >
            {(c) => (
              <Input
                {...c}
                name="receivedAt"
                type="datetime-local"
                dir="ltr"
                defaultValue={nowLocal()}
              />
            )}
          </Field>
          <Field id="ln-name" label={tc("form.fullName")} required>
            {(c) => <Input {...c} name="fullName" />}
          </Field>
          <Field id="ln-id" label={tc("form.idNumber")}>
            {(c) => (
              <Input {...c} name="idNumber" dir="ltr" autoComplete="off" />
            )}
          </Field>
          <Field id="ln-order" label={tc("form.orderNumber")}>
            {(c) => <Input {...c} name="orderNumber" dir="ltr" />}
          </Field>
          <Field id="ln-email" label={tc("labels.email")}>
            {(c) => <Input {...c} name="email" type="email" />}
          </Field>
          <Field id="ln-phone" label={tc("labels.phone")}>
            {(c) => <Input {...c} name="phone" type="tel" />}
          </Field>
          <Field id="ln-reason" label={tc("form.reason")}>
            {(c) => (
              <Select
                {...c}
                name="reason"
                placeholder={tc("form.reasonNone")}
                options={CANCELLATION_REASONS.map((r) => ({
                  value: r,
                  label: tc(`reason.${r}`),
                }))}
              />
            )}
          </Field>
          <Field id="ln-eligible" label={tc("form.eligibleGroup")}>
            {(c) => (
              <Select
                {...c}
                name="eligibleGroup"
                options={ELIGIBLE_GROUPS.map((g) => ({
                  value: g,
                  label: tc(`eligibleGroup.${g}`),
                }))}
              />
            )}
          </Field>
          <Field id="ln-locale" label="שפת האישור / Acknowledgement language">
            {(c) => (
              <Select
                {...c}
                name="noticeLocale"
                options={[
                  { value: "he", label: "עברית" },
                  { value: "en", label: "English" },
                ]}
              />
            )}
          </Field>
        </div>
        <Field id="ln-message" label={tc("form.message")}>
          {(c) => <Textarea {...c} name="message" />}
        </Field>
      </AdminActionForm>
    </div>
  );
}
