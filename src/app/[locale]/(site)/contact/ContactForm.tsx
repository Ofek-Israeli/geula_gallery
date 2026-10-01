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

const FIELDS = ["topic", "name", "email", "phone", "message"] as const;

/**
 * The contact form (spec §5.8): a general question or a commission enquiry. A plain POST before
 * hydration (Server Action with progressive enhancement); after a success it shows the
 * acknowledgement in place.
 */
export function ContactForm({
  action,
  locale,
  topic,
  formStart,
}: {
  action: (prev: State, payload: FormData) => Promise<State>;
  locale: Locale;
  topic: "GENERAL" | "COMMISSION";
  formStart: string;
}) {
  const t = useTranslations("requests");
  const tc = useTranslations("catalog.contact");
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
        data-testid="contact-thanks"
      >
        <h3 className="text-2xl">{t("thanks.title")}</h3>
        <p>{t("thanks.body", { email: state.data.email })}</p>
      </div>
    );
  }

  const fieldErrors = state && !state.ok ? (state.error.fieldErrors ?? {}) : {};
  const err = (name: string) => fieldErrors[name]?.[0];
  const label = (f: (typeof FIELDS)[number]) =>
    f === "topic" ? tc("topic") : t(`fields.${f}`);
  const errors =
    state && !state.ok
      ? state.error.code === "INVALID_INPUT"
        ? FIELDS.filter((f) => err(f)).map((f) => ({
            fieldId: `contact-${f}`,
            message: `${label(f)}: ${err(f)}`,
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
      data-testid="contact-form"
      noValidate
    >
      <ErrorSummary errors={errors} />
      <input type="hidden" name={LOCALE_FIELD} value={locale} />
      <input type="hidden" name={FORM_START_FIELD} value={formStart} />
      <HoneypotField />
      <Field id="contact-topic" label={tc("topic")} error={err("topic")}>
        {(c) => (
          <Select
            {...c}
            name="topic"
            defaultValue={topic}
            options={[
              { value: "GENERAL", label: tc("topicGeneral") },
              { value: "COMMISSION", label: tc("topicCommission") },
            ]}
          />
        )}
      </Field>
      <Field
        id="contact-name"
        label={t("fields.name")}
        required
        error={err("name")}
      >
        {(c) => <Input {...c} name="name" autoComplete="name" />}
      </Field>
      <Field
        id="contact-email"
        label={t("fields.email")}
        required
        error={err("email")}
      >
        {(c) => <Input {...c} name="email" type="email" autoComplete="email" />}
      </Field>
      <Field id="contact-phone" label={t("fields.phone")} error={err("phone")}>
        {(c) => <Input {...c} name="phone" type="tel" autoComplete="tel" />}
      </Field>
      <Field
        id="contact-message"
        label={t("fields.message")}
        hint={tc("messageHint")}
        required
        error={err("message")}
      >
        {(c) => <Textarea {...c} name="message" rows={6} />}
      </Field>
      <div>
        <SubmitButton
          pendingLabel={t("submitting")}
          data-testid="contact-submit"
        >
          {t("submit")}
        </SubmitButton>
      </div>
    </form>
  );
}
