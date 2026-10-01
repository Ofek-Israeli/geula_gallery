"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { ErrorSummary } from "@/components/ui/ErrorSummary";
import { Field } from "@/components/ui/Field";
import { HoneypotField } from "@/components/ui/HoneypotField";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Textarea } from "@/components/ui/Textarea";
import { FORM_START_FIELD, LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";

type State =
  | { ok: true; data: { email: string } }
  | {
      ok: false;
      error: {
        code: string;
        fieldErrors?: Record<string, string[] | undefined>;
      };
    }
  | null;

const FIELDS = [
  "name",
  "email",
  "phone",
  "country",
  "offerAmount",
  "message",
] as const;

/**
 * The public question / quote form (spec §5.8). Works as a plain POST before hydration (Server
 * Action with progressive enhancement); after a success it shows the acknowledgement in place.
 */
export function RequestForm({
  action,
  locale,
  kind,
  slug,
  formStart,
  countries,
  defaultCountry,
}: {
  action: (prev: State, payload: FormData) => Promise<State>;
  locale: Locale;
  kind: "question" | "quote" | "offer";
  slug: string;
  formStart: string;
  countries: { code: string; name: string }[];
  defaultCountry: string;
}) {
  const t = useTranslations("requests");
  const [state, formAction] = useActionState(action, null);
  const thanksRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state?.ok) thanksRef.current?.focus();
  }, [state]);

  if (state?.ok) {
    return (
      <div
        ref={thanksRef}
        tabIndex={-1}
        role="status"
        className="flex flex-col gap-2 border border-line p-5"
        data-testid="request-thanks"
      >
        <h2 className="text-2xl">{t("thanks.title")}</h2>
        <p>{t("thanks.body", { email: state.data.email })}</p>
      </div>
    );
  }

  const fieldErrors = state && !state.ok ? (state.error.fieldErrors ?? {}) : {};
  const err = (name: string) => fieldErrors[name]?.[0];
  const errors =
    state && !state.ok
      ? state.error.code === "INVALID_INPUT"
        ? FIELDS.filter((f) => err(f)).map((f) => ({
            fieldId: `req-${f}`,
            message: `${t(`fields.${f}`)}: ${err(f)}`,
          }))
        : [
            {
              message: t.has(`errors.${state.error.code}` as never)
                ? t(`errors.${state.error.code}` as never)
                : t("errors.generic"),
            },
          ]
      : [];

  return (
    <form
      action={formAction}
      className="relative flex flex-col gap-4"
      data-testid="request-form"
      noValidate
    >
      <ErrorSummary errors={errors} />
      <input type="hidden" name={LOCALE_FIELD} value={locale} />
      <input type="hidden" name={FORM_START_FIELD} value={formStart} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="slug" value={slug} />
      <HoneypotField />
      <Field
        id="req-name"
        label={t("fields.name")}
        required
        error={err("name")}
      >
        {(c) => <Input {...c} name="name" autoComplete="name" />}
      </Field>
      <Field
        id="req-email"
        label={t("fields.email")}
        required
        error={err("email")}
      >
        {(c) => <Input {...c} name="email" type="email" autoComplete="email" />}
      </Field>
      <Field id="req-phone" label={t("fields.phone")} error={err("phone")}>
        {(c) => <Input {...c} name="phone" type="tel" autoComplete="tel" />}
      </Field>
      <Field
        id="req-country"
        label={t("fields.country")}
        hint={kind === "quote" ? t("fields.countryHint") : undefined}
        required={kind !== "question"}
        error={err("country")}
      >
        {(c) => (
          <Select
            {...c}
            name="country"
            defaultValue={defaultCountry}
            options={countries.map((o) => ({ value: o.code, label: o.name }))}
          />
        )}
      </Field>
      {kind === "offer" ? (
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field
            id="req-offerAmount"
            label={t("fields.offerAmount")}
            hint={t("fields.offerAmountHint")}
            required
            error={err("offerAmount")}
          >
            {(c) => (
              <Input {...c} name="offerAmount" inputMode="decimal" dir="ltr" />
            )}
          </Field>
          <Field id="req-offerCurrency" label={t("fields.currency")}>
            {(c) => (
              <Select
                {...c}
                name="offerCurrency"
                defaultValue="ILS"
                options={[
                  { value: "ILS", label: "ILS ₪" },
                  { value: "USD", label: "USD $" },
                ]}
              />
            )}
          </Field>
        </div>
      ) : null}
      <Field
        id="req-message"
        label={t("fields.message")}
        hint={kind === "quote" ? t("fields.messageQuoteHint") : undefined}
        required={kind === "question"}
        error={err("message")}
      >
        {(c) => <Textarea {...c} name="message" rows={6} />}
      </Field>
      <div>
        <SubmitButton
          pendingLabel={t("submitting")}
          data-testid="request-submit"
        >
          {t("submit")}
        </SubmitButton>
      </div>
    </form>
  );
}
