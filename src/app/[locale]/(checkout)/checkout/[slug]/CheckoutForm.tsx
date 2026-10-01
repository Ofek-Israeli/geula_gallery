"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useActionState, useRef } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { ErrorSummary, type FormErrorItem } from "@/components/ui/ErrorSummary";
import { Field } from "@/components/ui/Field";
import { HoneypotField } from "@/components/ui/HoneypotField";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Link } from "@/i18n/navigation";
import { FORM_START_FIELD, LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import type { ActionState } from "@/server/next/actions";
import type { CheckoutActionData } from "./actions";

type State = ActionState<CheckoutActionData>;

export interface CheckoutFormProps {
  action: (prev: State, formData: FormData) => Promise<State>;
  locale: Locale;
  hidden: {
    slug: string;
    country: string;
    method: string;
    currency: string;
    expectedTotalMinor: number;
    clientRequestId: string;
    formStart: string;
  };
  needsAddress: boolean;
  international: boolean;
  holdMinutes: number;
  providers: { id: string; label: string; description?: string }[];
  /** The rendered pre-contract disclosure (server component output). */
  disclosure: ReactNode;
  reloadHref: string;
}

const FIELD_IDS: Record<string, string> = {
  name: "co-name",
  email: "co-email",
  phone: "co-phone",
  line1: "co-line1",
  line2: "co-line2",
  city: "co-city",
  region: "co-region",
  postalCode: "co-postal",
  companyName: "co-company",
  vatId: "co-vat",
  terms: "co-terms",
  age: "co-age",
  dap: "co-dap",
  providerId: "co-provider",
};

/**
 * The checkout details form (spec §5.1 step 2): buyer details, the address (Latin abroad), the
 * pre-contract disclosure, the unticked consent checkboxes, the provider radios and the hold
 * notice. Works without JavaScript (a plain POST to the Server Action); with JavaScript the
 * values survive a failed submit.
 */
export function CheckoutForm(props: CheckoutFormProps) {
  const t = useTranslations("checkout");
  const tf = useTranslations("common.form");
  const values = useRef<Record<string, string>>({});
  const submits = useRef(0);
  const [state, formAction] = useActionState<State, FormData>(
    async (prev, formData) => {
      values.current = Object.fromEntries(
        [...formData.entries()].map(([k, v]) => [k, String(v)]),
      );
      submits.current += 1;
      return props.action(prev, formData);
    },
    null,
  );
  const v = values.current;
  const fieldErrors = state && !state.ok ? (state.error.fieldErrors ?? {}) : {};
  const errorFor = (name: string): string | undefined => {
    const list = fieldErrors[name];
    if (!list?.length) return undefined;
    if (["terms", "age", "dap"].includes(name)) return t("consent.required");
    return list[0] === "required" ? tf("invalid") : list[0];
  };

  const summary: FormErrorItem[] = [];
  let banner: ReactNode = null;
  if (state && !state.ok) {
    const code = state.error.code;
    if (code === "INVALID_INPUT") {
      for (const name of Object.keys(fieldErrors)) {
        const message = errorFor(name);
        if (message) summary.push({ fieldId: FIELD_IDS[name], message });
      }
      if (summary.length === 0) summary.push({ message: t("errors.fix") });
    } else if (code === "RATE_LIMITED") {
      banner = tf("rateLimited");
    } else if (code === "TOO_FAST") {
      banner = tf("tooFast");
    } else {
      banner = t("errors.generic");
    }
  } else if (state?.ok) {
    const d = state.data;
    if (d.kind === "price_changed") {
      banner = (
        <>
          {t("errors.price_changed")}{" "}
          <a href={props.reloadHref} className="underline">
            {t("errors.reload")}
          </a>
        </>
      );
    } else if (d.kind === "just_reserved") {
      banner = t("errors.just_reserved");
    } else if (d.kind === "refused") {
      const key = `errors.${d.code}`;
      banner = t.has(key as never) ? t(key as never) : t("errors.generic");
    } else if (d.kind === "provider_error") {
      banner = (
        <>
          {t("errors.provider_error")}{" "}
          <Link
            href={paths.order(d.orderNumber, d.accessToken)}
            className="underline"
          >
            {t("errors.openOrder")}
          </Link>
        </>
      );
    }
  }

  const h = props.hidden;
  return (
    <form
      key={submits.current}
      action={formAction}
      noValidate
      className="relative flex flex-col gap-6"
      data-testid="checkout-form"
    >
      <input type="hidden" name={LOCALE_FIELD} value={props.locale} />
      <input type="hidden" name={FORM_START_FIELD} value={h.formStart} />
      <input type="hidden" name="slug" value={h.slug} />
      <input type="hidden" name="country" value={h.country} />
      <input type="hidden" name="method" value={h.method} />
      <input type="hidden" name="currency" value={h.currency} />
      <input
        type="hidden"
        name="expectedTotalMinor"
        value={String(h.expectedTotalMinor)}
      />
      <input type="hidden" name="clientRequestId" value={h.clientRequestId} />
      <HoneypotField />

      {banner ? (
        <div
          role="alert"
          className="rounded-sm border-2 border-reddot bg-white p-4"
          data-testid="checkout-error"
        >
          {banner}
        </div>
      ) : null}
      <ErrorSummary errors={summary} />

      <fieldset className="flex flex-col gap-4">
        <legend className="mbe-2 text-2xl">{t("details.title")}</legend>
        <Field
          id={FIELD_IDS.name ?? "co-name"}
          label={t("details.name")}
          required
          error={errorFor("name")}
        >
          {(c) => (
            <Input
              {...c}
              name="name"
              autoComplete="name"
              defaultValue={v.name ?? ""}
            />
          )}
        </Field>
        <Field
          id={FIELD_IDS.email ?? "co-email"}
          label={t("details.email")}
          hint={t("details.emailHint")}
          required
          error={errorFor("email")}
        >
          {(c) => (
            <Input
              {...c}
              type="email"
              name="email"
              autoComplete="email"
              defaultValue={v.email ?? ""}
            />
          )}
        </Field>
        <Field
          id={FIELD_IDS.phone ?? "co-phone"}
          label={t("details.phone")}
          hint={t("details.phoneHint")}
          required
          error={errorFor("phone")}
        >
          {(c) => (
            <Input
              {...c}
              type="tel"
              name="phone"
              autoComplete="tel"
              defaultValue={v.phone ?? ""}
            />
          )}
        </Field>
      </fieldset>

      {props.needsAddress ? (
        <fieldset className="flex flex-col gap-4">
          <legend className="mbe-2 text-xl">{t("details.addressTitle")}</legend>
          {props.international ? (
            <p className="text-sm text-ink-muted">{t("details.latinHint")}</p>
          ) : null}
          {(
            [
              ["line1", "address-line1", true],
              ["line2", "address-line2", false],
              ["city", "address-level2", true],
              ["region", "address-level1", false],
              ["postalCode", "postal-code", props.international],
            ] as const
          ).map(([name, auto, req]) => (
            <Field
              key={name}
              id={FIELD_IDS[name] ?? name}
              label={t(`details.${name}`)}
              required={req}
              error={errorFor(name)}
            >
              {(c) => (
                <Input
                  {...c}
                  name={name}
                  autoComplete={auto}
                  dir={props.international ? "ltr" : undefined}
                  defaultValue={v[name] ?? ""}
                />
              )}
            </Field>
          ))}
        </fieldset>
      ) : (
        <p className="text-sm text-ink-muted">{t("details.pickupNote")}</p>
      )}

      <fieldset className="flex flex-col gap-4">
        <Field
          id={FIELD_IDS.companyName ?? "co-company"}
          label={t("details.companyName")}
          error={errorFor("companyName")}
        >
          {(c) => (
            <Input
              {...c}
              name="companyName"
              autoComplete="organization"
              defaultValue={v.companyName ?? ""}
            />
          )}
        </Field>
        <Field
          id={FIELD_IDS.vatId ?? "co-vat"}
          label={t("details.vatId")}
          error={errorFor("vatId")}
        >
          {(c) => (
            <Input {...c} name="vatId" dir="ltr" defaultValue={v.vatId ?? ""} />
          )}
        </Field>
      </fieldset>

      {props.disclosure}

      <fieldset className="flex flex-col gap-3">
        <legend className="mbe-2 text-xl">{t("consent.legend")}</legend>
        <Checkbox
          id={FIELD_IDS.terms ?? "co-terms"}
          name="terms"
          label={t("consent.terms")}
          required
          defaultChecked={v.terms === "on"}
          error={errorFor("terms")}
        />
        <Checkbox
          id={FIELD_IDS.age ?? "co-age"}
          name="age"
          label={t("consent.age")}
          required
          defaultChecked={v.age === "on"}
          error={errorFor("age")}
        />
        {props.international ? (
          <Checkbox
            id={FIELD_IDS.dap ?? "co-dap"}
            name="dap"
            label={t("consent.dap")}
            required
            defaultChecked={v.dap === "on"}
            error={errorFor("dap")}
          />
        ) : null}
        <Checkbox
          id="co-receipt"
          name="receiptEmail"
          label={t("consent.receiptEmail")}
          defaultChecked={v.receiptEmail === "on"}
        />
      </fieldset>

      <RadioGroup
        id={FIELD_IDS.providerId ?? "co-provider"}
        name="providerId"
        legend={t("provider.legend")}
        required
        defaultValue={v.providerId ?? props.providers[0]?.id}
        options={props.providers.map((p) => ({
          value: p.id,
          label: p.label,
          description: p.description,
        }))}
        error={fieldErrors.providerId ? tf("invalid") : undefined}
      />

      <p className="text-sm text-ink-muted">{t("privacy")}</p>
      <p className="font-medium">
        {t("holdNotice", { minutes: props.holdMinutes })}
      </p>
      <div>
        <SubmitButton
          pendingLabel={t("submitting")}
          data-testid="checkout-submit"
        >
          {t("submit")}
        </SubmitButton>
      </div>
      <p className="text-sm text-ink-muted">{t("provider.redirectNote")}</p>
    </form>
  );
}
