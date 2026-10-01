"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";

type State<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        fieldErrors?: Record<string, string[] | undefined>;
      };
    }
  | null;

const KNOWN_ERRORS = new Set([
  "ORDER_NOT_PAID",
  "FULFILLMENT_BLOCKED",
  "NOT_A_CARRIER_SHIPMENT",
  "SHIPMENT_STATE",
  "TRACKING_NUMBER_IN_USE",
  "NOT_FOUND",
]);

/** Minimal manual tracking entry (spec §5.5 step 3a); WS3 replaces it with the fulfillment screen. */
export function ManualTrackingForm<T extends { status: string }>({
  action,
  orderId,
  locale,
  defaults,
}: {
  action: (prev: State<T>, payload: FormData) => Promise<State<T>>;
  orderId: string;
  locale: Locale;
  defaults: {
    carrierName: string;
    trackingNumber: string;
    trackingUrl: string;
  };
}) {
  const t = useTranslations("admin-orders");
  const [state, formAction] = useActionState(action, null);
  const fieldError = (name: string) =>
    state && !state.ok ? state.error.fieldErrors?.[name]?.[0] : undefined;
  return (
    <form
      action={formAction}
      className="flex flex-col gap-4"
      data-testid="manual-tracking-form"
    >
      <input type="hidden" name={LOCALE_FIELD} value={locale} />
      <input type="hidden" name="orderId" value={orderId} />
      <Field
        id="mt-carrier"
        label={t("tracking.carrierName")}
        required
        error={fieldError("carrierName")}
      >
        {(c) => (
          <Input
            {...c}
            name="carrierName"
            defaultValue={defaults.carrierName}
          />
        )}
      </Field>
      <Field
        id="mt-number"
        label={t("tracking.trackingNumber")}
        required
        error={fieldError("trackingNumber")}
      >
        {(c) => (
          <Input
            {...c}
            name="trackingNumber"
            dir="ltr"
            defaultValue={defaults.trackingNumber}
          />
        )}
      </Field>
      <Field
        id="mt-url"
        label={t("tracking.trackingUrl")}
        error={fieldError("trackingUrl")}
      >
        {(c) => (
          <Input
            {...c}
            name="trackingUrl"
            type="url"
            defaultValue={defaults.trackingUrl}
          />
        )}
      </Field>
      <Checkbox
        id="mt-handed"
        name="handedOver"
        label={t("tracking.handedOver")}
      />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel={t("tracking.saving")}>
          {t("tracking.submit")}
        </SubmitButton>
        {state ? (
          <span role="status" className="text-sm" data-testid="tracking-result">
            {state.ok
              ? t("tracking.saved", { status: state.data.status })
              : KNOWN_ERRORS.has(state.error.code)
                ? t(`errors.${state.error.code}` as never)
                : state.error.code === "INVALID_INPUT"
                  ? null
                  : t("errors.generic")}
          </span>
        ) : null}
      </div>
    </form>
  );
}
