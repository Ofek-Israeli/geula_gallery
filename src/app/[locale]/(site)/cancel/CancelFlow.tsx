"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { ErrorSummary, type FormErrorItem } from "@/components/ui/ErrorSummary";
import { Field } from "@/components/ui/Field";
import { HoneypotField } from "@/components/ui/HoneypotField";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/Textarea";
import { FORM_START_FIELD, LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";
import { VALIDATION_MESSAGES } from "@/lib/validation/messages";
import type { ActionState } from "@/server/next/actions";
import type { CancelFlowState, CancelFormValues } from "./actions";

const REASONS = [
  "CHANGE_OF_MIND",
  "DEFECT",
  "NOT_AS_DESCRIBED",
  "NOT_DELIVERED",
  "OTHER",
] as const;
const GROUPS = ["NONE", "SENIOR_65", "DISABILITY", "NEW_IMMIGRANT"] as const;
const SHIPPED_TO = ["IL", "EU", "OTHER"] as const;

const IDS: Record<string, string> = {
  fullName: "cx-name",
  idNumber: "cx-id",
  orderNumber: "cx-order",
  email: "cx-email",
  phone: "cx-phone",
  reason: "cx-reason",
  shippedTo: "cx-shipped",
  eligibleGroup: "cx-eligible",
  message: "cx-message",
};

type Action = (
  prev: ActionState<CancelFlowState>,
  payload: FormData,
) => Promise<ActionState<CancelFlowState>>;

/**
 * The cancellation flow (spec §5.7 steps 3–4): form → review → acknowledgement. The Server Action
 * is passed to `useActionState` directly, so every step is a plain POST that also works without
 * JavaScript. The ID number is never echoed back in full after the form step.
 */
export function CancelFlow({
  action,
  locale,
  formStart,
  prefillOrder,
}: {
  action: Action;
  locale: Locale;
  formStart: string;
  prefillOrder?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const data = state?.ok ? state.data : null;

  if (data?.step === "ack") return <Acknowledgement ack={data.ack} />;
  if (data?.step === "review") {
    return (
      <Review
        formAction={formAction}
        locale={locale}
        formStart={formStart}
        data={data}
      />
    );
  }
  const failure = state && !state.ok ? state.error.code : null;
  return (
    <NoticeForm
      formAction={formAction}
      locale={locale}
      formStart={formStart}
      values={
        data?.step === "form"
          ? data.values
          : { orderNumber: prefillOrder ?? "" }
      }
      errors={data?.step === "form" ? (data.errors ?? {}) : {}}
      banner={data?.step === "form" ? (data.banner ?? null) : failure}
    />
  );
}

function Hidden({
  locale,
  formStart,
  step,
}: {
  locale: Locale;
  formStart: string;
  step: string;
}) {
  return (
    <>
      <input type="hidden" name={LOCALE_FIELD} value={locale} />
      <input type="hidden" name={FORM_START_FIELD} value={formStart} />
      <input type="hidden" name="step" value={step} />
      <HoneypotField />
    </>
  );
}

function Banner({ code }: { code: string | null }) {
  const t = useTranslations("cancel.form.banner");
  if (!code) return null;
  const key = t.has(code as never) ? code : "generic";
  return (
    <div
      role="alert"
      className="rounded-sm border-2 border-reddot bg-white p-4"
      data-testid="cancel-banner"
    >
      {t(key as never)}
    </div>
  );
}

function NoticeForm({
  formAction,
  locale,
  formStart,
  values,
  errors,
  banner,
}: {
  formAction: (fd: FormData) => void;
  locale: Locale;
  formStart: string;
  values: CancelFormValues;
  errors: Record<string, string>;
  banner: string | null;
}) {
  const t = useTranslations("cancel");
  const errorText = (field: string): string | undefined => {
    const code = errors[field];
    if (!code) return undefined;
    if (code in VALIDATION_MESSAGES) {
      return VALIDATION_MESSAGES[code as keyof typeof VALIDATION_MESSAGES][
        locale
      ];
    }
    const key = `form.errors.${code}`;
    return t.has(key as never)
      ? t(key as never)
      : t("form.errors.invalid" as never);
  };
  const summary: FormErrorItem[] = Object.keys(errors)
    .map((f) => ({ fieldId: IDS[f], message: errorText(f) ?? "" }))
    .filter((e) => e.message);

  return (
    <form
      key={JSON.stringify(values)}
      action={formAction}
      noValidate
      className="relative flex flex-col gap-5"
      data-testid="cancel-form"
    >
      <Hidden locale={locale} formStart={formStart} step="review" />
      <Banner code={banner} />
      <ErrorSummary errors={summary} title={t("form.errors.summary")} />
      <Field
        id={IDS.fullName ?? ""}
        label={t("form.fullName")}
        required
        error={errorText("fullName")}
      >
        {(c) => (
          <Input
            {...c}
            name="fullName"
            autoComplete="name"
            defaultValue={values.fullName ?? ""}
          />
        )}
      </Field>
      <div className="grid gap-5 md:grid-cols-2">
        <Field
          id={IDS.idNumber ?? ""}
          label={t("form.idNumber")}
          hint={t("form.idHint")}
          error={errorText("idNumber")}
        >
          {(c) => (
            <Input
              {...c}
              name="idNumber"
              dir="ltr"
              inputMode="text"
              autoComplete="off"
              defaultValue=""
            />
          )}
        </Field>
        <Field
          id={IDS.orderNumber ?? ""}
          label={t("form.orderNumber")}
          hint={t("form.orderHint")}
          error={errorText("orderNumber")}
        >
          {(c) => (
            <Input
              {...c}
              name="orderNumber"
              dir="ltr"
              autoComplete="off"
              defaultValue={values.orderNumber ?? ""}
            />
          )}
        </Field>
        <Field
          id={IDS.email ?? ""}
          label={t("form.email")}
          error={errorText("email")}
        >
          {(c) => (
            <Input
              {...c}
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={values.email ?? ""}
            />
          )}
        </Field>
        <Field
          id={IDS.phone ?? ""}
          label={t("form.phone")}
          error={errorText("phone")}
        >
          {(c) => (
            <Input
              {...c}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              defaultValue={values.phone ?? ""}
            />
          )}
        </Field>
        <Field
          id={IDS.reason ?? ""}
          label={t("form.reason")}
          error={errorText("reason")}
        >
          {(c) => (
            <Select
              {...c}
              name="reason"
              defaultValue={values.reason ?? ""}
              placeholder={t("form.reasonNone")}
              options={REASONS.map((r) => ({
                value: r,
                label: t(`reason.${r}`),
              }))}
            />
          )}
        </Field>
        <Field
          id={IDS.shippedTo ?? ""}
          label={t("form.shippedTo")}
          error={errorText("shippedTo")}
        >
          {(c) => (
            <Select
              {...c}
              name="shippedTo"
              defaultValue={values.shippedTo ?? ""}
              placeholder={t("form.shippedToNone")}
              options={SHIPPED_TO.map((s) => ({
                value: s,
                label: t(`form.shippedToOptions.${s}`),
              }))}
            />
          )}
        </Field>
      </div>
      <Field
        id={IDS.eligibleGroup ?? ""}
        label={t("form.eligibleGroup")}
        hint={t("form.eligibleHint")}
        error={errorText("eligibleGroup")}
      >
        {(c) => (
          <Select
            {...c}
            name="eligibleGroup"
            defaultValue={values.eligibleGroup ?? "NONE"}
            options={GROUPS.map((g) => ({
              value: g,
              label: t(`eligibleGroup.${g}`),
            }))}
          />
        )}
      </Field>
      <Field
        id={IDS.message ?? ""}
        label={t("form.message")}
        error={errorText("message")}
      >
        {(c) => (
          <Textarea
            {...c}
            name="message"
            maxLength={2000}
            defaultValue={values.message ?? ""}
          />
        )}
      </Field>
      <div>
        <SubmitButton pendingLabel={t("form.pending")}>
          {t("form.submit")}
        </SubmitButton>
      </div>
    </form>
  );
}

function Rows({
  rows,
}: {
  rows: { label: string; value: string | null | undefined; ltr?: boolean }[];
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
      {rows
        .filter((r) => r.value)
        .map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-ink-muted">{r.label}</dt>
            <dd className="mbe-1 sm:mbe-0">
              {r.ltr ? <bdi dir="ltr">{r.value}</bdi> : <bdi>{r.value}</bdi>}
            </dd>
          </div>
        ))}
    </dl>
  );
}

function Review({
  formAction,
  locale,
  formStart,
  data,
}: {
  formAction: (fd: FormData) => void;
  locale: Locale;
  formStart: string;
  data: Extract<CancelFlowState, { step: "review" }>;
}) {
  const t = useTranslations("cancel");
  const d = data.display;
  return (
    <section
      aria-labelledby="cancel-review-title"
      className="flex flex-col gap-5"
      data-testid="cancel-review"
    >
      <h3 id="cancel-review-title" className="text-xl">
        {t("review.title")}
      </h3>
      <p>{t("review.intro")}</p>
      <Rows
        rows={[
          { label: t("labels.fullName"), value: d.fullName },
          { label: t("labels.idNumber"), value: d.idNumberMasked, ltr: true },
          { label: t("labels.orderNumber"), value: d.orderNumber, ltr: true },
          { label: t("labels.email"), value: d.email, ltr: true },
          { label: t("labels.phone"), value: d.phone, ltr: true },
          {
            label: t("labels.reason"),
            value: d.reason ? t(`reason.${d.reason}`) : null,
          },
          {
            label: t("labels.shippedTo"),
            value: d.shippedTo
              ? t(`form.shippedToOptions.${d.shippedTo}`)
              : null,
          },
          {
            label: t("labels.eligibleGroup"),
            value:
              d.eligibleGroup !== "NONE"
                ? t(`eligibleGroup.${d.eligibleGroup}`)
                : null,
          },
          { label: t("labels.message"), value: d.message },
        ]}
      />
      <div className="flex flex-wrap gap-3">
        <form action={formAction}>
          <Hidden locale={locale} formStart={formStart} step="confirm" />
          <input type="hidden" name="token" value={data.token} />
          <SubmitButton pendingLabel={t("review.pending")}>
            {t("review.confirm")}
          </SubmitButton>
        </form>
        <form action={formAction}>
          <Hidden locale={locale} formStart={formStart} step="edit" />
          <input type="hidden" name="token" value={data.token} />
          <SubmitButton variant="secondary">{t("review.edit")}</SubmitButton>
        </form>
      </div>
    </section>
  );
}

function Acknowledgement({
  ack,
}: {
  ack: Extract<CancelFlowState, { step: "ack" }>["ack"];
}) {
  const t = useTranslations("cancel");
  return (
    <section
      aria-labelledby="cancel-ack-title"
      className="flex flex-col gap-5 rounded-sm border-2 border-ink bg-white p-5"
      data-testid="cancel-ack"
      tabIndex={-1}
    >
      <h3 id="cancel-ack-title" className="text-2xl" role="status">
        {t("ack.title")}
      </h3>
      <p>{t("ack.intro")}</p>
      <p className="text-lg font-semibold">
        {t("labels.number")}:{" "}
        <bdi dir="ltr" data-testid="cancel-number">
          {ack.number}
        </bdi>
      </p>
      <p>{t("ack.receivedAt", { date: ack.receivedAtText })}</p>
      <Rows
        rows={[
          { label: t("labels.fullName"), value: ack.fullName },
          { label: t("labels.idNumber"), value: ack.idNumberMasked, ltr: true },
          { label: t("labels.orderNumber"), value: ack.orderNumber, ltr: true },
          { label: t("labels.email"), value: ack.email, ltr: true },
          { label: t("labels.phone"), value: ack.phone, ltr: true },
          {
            label: t("labels.reason"),
            value: ack.reason ? t(`reason.${ack.reason}`) : null,
          },
          {
            label: t("labels.eligibleGroup"),
            value:
              ack.eligibleGroup !== "NONE"
                ? t(`eligibleGroup.${ack.eligibleGroup}`)
                : null,
          },
          { label: t("labels.message"), value: ack.message },
          { label: t("labels.channel"), value: t(`channel.${ack.channel}`) },
        ]}
      />
      <p className="font-medium">
        {t("ack.refundDue", {
          date: new Intl.DateTimeFormat(
            ack.locale === "he" ? "he-IL" : "en-IL",
            {
              timeZone: "Asia/Jerusalem",
              dateStyle: "long",
            },
          ).format(new Date(ack.refundDueAt)),
        })}
      </p>
      <p className="text-ink-muted">
        {ack.email ? t("ack.emailSent") : t("ack.noEmail")}
      </p>
      <div className="flex flex-wrap gap-3 print:hidden">
        <button
          type="button"
          className={buttonClasses("secondary")}
          onClick={() => window.print()}
        >
          {t("ack.print")}
        </button>
      </div>
    </section>
  );
}
