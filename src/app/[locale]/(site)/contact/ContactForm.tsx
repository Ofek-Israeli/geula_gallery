"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { ErrorSummary } from "@/components/ui/ErrorSummary";
import { Field } from "@/components/ui/Field";
import { HoneypotField } from "@/components/ui/HoneypotField";
import { Input } from "@/components/ui/Input";
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

const FIELDS = ["name", "email", "phone", "message"] as const;

/**
 * The contact form (spec §5.8): a general question. A plain POST before hydration (Server Action
 * with progressive enhancement); after a success it shows the acknowledgement in place. Without
 * visitor emails (`visitorEmail` false) it promises no email and asks for a phone number.
 */
export function ContactForm({
  action,
  locale,
  formStart,
  visitorEmail = true,
}: {
  action: (prev: State, payload: FormData) => Promise<State>;
  locale: Locale;
  formStart: string;
  /** `EMAIL_TO_VISITORS`: the visitor gets an emailed confirmation and answer. */
  visitorEmail?: boolean;
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
        data-testid="contact-thanks"
      >
        <h3 className="text-2xl">{t("thanks.title")}</h3>
        <p>
          {visitorEmail
            ? t("thanks.body", { email: state.data.email })
            : t("thanks.bodyNoEmail")}
        </p>
      </div>
    );
  }

  const fieldErrors = state && !state.ok ? (state.error.fieldErrors ?? {}) : {};
  const err = (name: string) => fieldErrors[name]?.[0];
  const label = (f: (typeof FIELDS)[number]) => t(`fields.${f}`);
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
      <Field
        id="contact-phone"
        label={t("fields.phone")}
        hint={visitorEmail ? undefined : t("fields.phoneHint")}
        error={err("phone")}
      >
        {(c) => <Input {...c} name="phone" type="tel" autoComplete="tel" />}
      </Field>
      <Field
        id="contact-message"
        label={t("fields.message")}
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
