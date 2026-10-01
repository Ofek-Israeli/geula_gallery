"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";

type State<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string } }
  | null;

/**
 * "Recheck payment" (spec §6.10): calls the admin action, which runs `finalizeAttempt(…, 'admin')`
 * and revalidates, so the page re-renders with the new attempt and order state.
 */
export function RecheckButton<T extends { outcome: string }>({
  action,
  attemptId,
  locale,
}: {
  action: (prev: State<T>, payload: FormData) => Promise<State<T>>;
  attemptId: string;
  locale: Locale;
}) {
  const t = useTranslations("admin-orders");
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name={LOCALE_FIELD} value={locale} />
      <input type="hidden" name="attemptId" value={attemptId} />
      <SubmitButton
        variant="secondary"
        size="sm"
        pendingLabel={t("detail.rechecking")}
        data-testid="recheck-payment"
      >
        {t("detail.recheck")}
      </SubmitButton>
      {state ? (
        <span role="status" className="text-sm" data-testid="recheck-result">
          {state.ok
            ? t("detail.recheckResult", { outcome: state.data.outcome })
            : t("errors.generic")}
        </span>
      ) : null}
    </form>
  );
}
