"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useActionState } from "react";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";

type State<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string } }
  | null;

/**
 * One admin decision form: hidden locale + cancellation id, the given fields, a submit button and
 * the result (translated `cancel.admin.errors.<code>`, or "done"). The page re-renders through the
 * action's `revalidate` effect.
 */
export function AdminActionForm<T>({
  action,
  locale,
  cancellationId,
  submitLabel,
  variant = "secondary",
  children,
  testId,
  confirm,
}: {
  action: (prev: State<T>, payload: FormData) => Promise<State<T>>;
  locale: Locale;
  cancellationId?: string;
  submitLabel: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  children?: ReactNode;
  testId?: string;
  /** A short sentence shown next to the button (no modal: the action is still one click). */
  confirm?: ReactNode;
}) {
  const t = useTranslations("cancel.admin");
  const [state, formAction] = useActionState(action, null);
  let message: string | null = null;
  if (state && !state.ok) {
    const key = `errors.${state.error.code}`;
    message = t.has(key as never) ? t(key as never) : t("errors.generic");
  } else if (state?.ok) {
    message = t("done");
  }
  return (
    <form
      action={formAction}
      className="flex flex-col gap-3"
      data-testid={testId}
    >
      <input type="hidden" name={LOCALE_FIELD} value={locale} />
      {cancellationId ? (
        <input type="hidden" name="cancellationId" value={cancellationId} />
      ) : null}
      {children}
      {confirm ? <p className="text-sm text-ink-muted">{confirm}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant={variant}>{submitLabel}</SubmitButton>
        {message ? (
          <span
            role="status"
            className={
              state?.ok ? "text-sm" : "text-sm font-medium text-reddot"
            }
            data-testid={testId ? `${testId}-result` : undefined}
          >
            {message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
