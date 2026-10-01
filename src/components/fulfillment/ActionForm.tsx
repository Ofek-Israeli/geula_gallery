"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useActionState } from "react";
import type { ButtonVariant } from "@/components/ui/Button";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { cx } from "@/lib/cx";
import { LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";

/** The `useActionState` shape of `adminAction` (UI code never imports `@/server`). */
export type FulfillmentActionState<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        formErrors?: string[];
        fieldErrors?: Record<string, string[] | undefined>;
      };
    }
  | null;

/**
 * One fulfillment step as a form (spec §5.5): hidden ids + locale, server-rendered fields as
 * children, a submit button (optionally behind a confirmation dialog) and a live status line.
 * Results read `{ status, error }` from the action's data: label refusals and unknown outcomes
 * get their own message; otherwise the new status (or "Saved") is announced.
 */
export function ActionForm<T>({
  action,
  locale,
  hidden = {},
  children,
  submit,
  pendingLabel,
  variant = "primary",
  confirm,
  testId,
  className,
}: {
  action: (
    prev: FulfillmentActionState<T>,
    payload: FormData,
  ) => Promise<FulfillmentActionState<T>>;
  locale: Locale;
  hidden?: Record<string, string>;
  children?: ReactNode;
  submit: ReactNode;
  pendingLabel?: ReactNode;
  variant?: ButtonVariant;
  confirm?: { message: ReactNode; confirmLabel: ReactNode };
  testId?: string;
  className?: string;
}) {
  const t = useTranslations("shipping");
  const [state, formAction] = useActionState(action, null);
  let message: string | null = null;
  let failed = false;
  if (state?.ok) {
    const data = (state.data ?? {}) as { status?: string; error?: string };
    if (data.error === "LABEL_REJECTED") {
      message = t("fulfill.result.labelRejected");
      failed = true;
    } else if (data.error === "LABEL_UNKNOWN") {
      message = t("fulfill.result.labelUnknown");
      failed = true;
    } else if (data.status && t.has(`status.${data.status}` as never)) {
      message = t("fulfill.result.status", {
        status: t(`status.${data.status}` as never),
      });
    } else {
      message = t("fulfill.result.saved");
    }
  } else if (state && !state.ok) {
    failed = true;
    const key = `errors.${state.error.code}`;
    message = t.has(key as never) ? t(key as never) : t("errors.generic");
    const details = Object.values(state.error.fieldErrors ?? {})
      .flat()
      .filter(Boolean);
    if (details.length > 0) message = `${message} ${details.join(" ")}`;
  }
  return (
    <form
      action={formAction}
      className={cx("flex flex-col gap-4", className)}
      data-testid={testId}
    >
      <input type="hidden" name={LOCALE_FIELD} value={locale} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <div className="flex flex-wrap items-center gap-3">
        {confirm ? (
          <ConfirmButton
            variant={variant}
            message={confirm.message}
            confirmLabel={confirm.confirmLabel}
          >
            {submit}
          </ConfirmButton>
        ) : (
          <SubmitButton variant={variant} pendingLabel={pendingLabel}>
            {submit}
          </SubmitButton>
        )}
        <span
          role="status"
          aria-live="polite"
          className={cx("text-sm", failed ? "text-reddot" : "text-ink-muted")}
          data-testid={testId ? `${testId}-result` : undefined}
        >
          {message}
        </span>
      </div>
    </form>
  );
}
