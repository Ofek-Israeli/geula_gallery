"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useActionState, useRef } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { ErrorSummary, type FormErrorItem } from "@/components/ui/ErrorSummary";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";
import type { ActionState } from "@/server/next/actions";
import type { LinkDetailsActionData } from "./actions";

type State = ActionState<LinkDetailsActionData>;

export interface LinkDetailsFormProps {
  action: (prev: State, formData: FormData) => Promise<State>;
  locale: Locale;
  number: string;
  k: string;
  country: string;
  international: boolean;
  /** Radios when the painter did not lock the shipping (labels prebuilt on the server). */
  methods: { value: string; label: string; description?: string }[];
  currentMethod: string;
  defaults: {
    recipient: string;
    line1: string;
    line2: string;
    city: string;
    region: string;
    postalCode: string;
    receiptEmail: boolean;
  };
  /** The pre-contract disclosure (server component output). */
  disclosure: ReactNode;
}

const IDS: Record<string, string> = {
  method: "ld-method",
  recipient: "ld-recipient",
  phone: "ld-phone",
  line1: "ld-line1",
  line2: "ld-line2",
  city: "ld-city",
  region: "ld-region",
  postalCode: "ld-postal",
  companyName: "ld-company",
  vatId: "ld-vat",
  terms: "ld-terms",
  age: "ld-age",
  dap: "ld-dap",
};

/**
 * "Complete your order" for a link order (spec §5.1 step 4, §5.8): delivery method (unless the
 * painter locked the shipping), address (Latin abroad), the pre-contract disclosure and the
 * unticked consents. A plain POST to a Server Action (works without JavaScript); with JavaScript
 * the values survive a refused submit.
 */
export function LinkDetailsForm(props: LinkDetailsFormProps) {
  const t = useTranslations("orders.link");
  const tc = useTranslations("checkout");
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
  const v: Record<string, string> = {
    recipient: props.defaults.recipient,
    line1: props.defaults.line1,
    line2: props.defaults.line2,
    city: props.defaults.city,
    region: props.defaults.region,
    postalCode: props.defaults.postalCode,
    ...values.current,
  };
  const fieldErrors = state && !state.ok ? (state.error.fieldErrors ?? {}) : {};
  const errorFor = (name: string): string | undefined => {
    const list = fieldErrors[name];
    if (!list?.length) return undefined;
    if (["terms", "age", "dap"].includes(name)) return tc("consent.required");
    return list[0] === "required" ? tf("invalid") : list[0];
  };
  const optional = (label: string): ReactNode => (
    <>
      {label}
      <span className="ms-1 font-normal text-ink-muted">{tf("optional")}</span>
    </>
  );

  const summary: FormErrorItem[] = [];
  let banner: ReactNode = null;
  if (state && !state.ok) {
    if (state.error.code === "INVALID_INPUT") {
      for (const name of Object.keys(fieldErrors)) {
        const message = errorFor(name);
        if (message) summary.push({ fieldId: IDS[name], message });
      }
      if (summary.length === 0) summary.push({ message: tc("errors.fix") });
    } else if (state.error.code === "RATE_LIMITED") {
      banner = tf("rateLimited");
    } else {
      banner = t("errors.generic");
    }
  } else if (state?.ok) {
    const key = `errors.${state.data.code}`;
    banner = t.has(key as never) ? t(key as never) : t("errors.generic");
  }

  const address: [string, string, boolean][] = [
    ["line1", "address-line1", true],
    ["line2", "address-line2", false],
    ["city", "address-level2", true],
    ["region", "address-level1", false],
    ["postalCode", "postal-code", props.international],
  ];
  return (
    <form
      key={submits.current}
      action={formAction}
      noValidate
      className="flex flex-col gap-6"
      data-testid="link-details-form"
    >
      <input type="hidden" name={LOCALE_FIELD} value={props.locale} />
      <input type="hidden" name="number" value={props.number} />
      <input type="hidden" name="k" value={props.k} />
      <input type="hidden" name="country" value={props.country} />
      <input
        type="hidden"
        name="needsAddress"
        value={
          props.methods.length > 0 || props.currentMethod !== "LOCAL_PICKUP"
            ? "on"
            : ""
        }
      />
      {props.methods.length === 0 ? (
        <input type="hidden" name="method" value={props.currentMethod} />
      ) : null}

      {banner ? (
        <div
          role="alert"
          className="rounded-sm border-2 border-reddot bg-white p-4"
          data-testid="link-details-error"
        >
          {banner}
        </div>
      ) : null}
      <ErrorSummary errors={summary} />

      {props.methods.length > 0 ? (
        <RadioGroup
          id={IDS.method ?? "ld-method"}
          name="method"
          legend={tc("delivery.methodLegend")}
          required
          defaultValue={v.method ?? props.currentMethod}
          options={props.methods}
        />
      ) : null}

      <fieldset className="flex flex-col gap-4">
        <legend className="mbe-2 text-xl">{tc("details.addressTitle")}</legend>
        <p className="text-sm text-ink-muted">
          {props.international ? tc("details.latinHint") : t("pickupHint")}
        </p>
        <Field
          id={IDS.recipient ?? "ld-recipient"}
          label={t("recipient")}
          required
          error={errorFor("recipient")}
        >
          {(c) => (
            <Input
              {...c}
              name="recipient"
              autoComplete="name"
              dir={props.international ? "ltr" : "auto"}
              defaultValue={v.recipient ?? ""}
            />
          )}
        </Field>
        {address.map(([name, auto, req]) => (
          <Field
            key={name}
            id={IDS[name] ?? name}
            label={
              req
                ? tc(`details.${name}` as never)
                : optional(tc(`details.${name}` as never))
            }
            required={req}
            error={errorFor(name)}
          >
            {(c) => (
              <Input
                {...c}
                name={name}
                autoComplete={auto}
                dir={props.international ? "ltr" : "auto"}
                defaultValue={v[name] ?? ""}
              />
            )}
          </Field>
        ))}
        <Field
          id={IDS.phone ?? "ld-phone"}
          label={optional(tc("details.phone"))}
          hint={tc("details.phoneHint")}
          error={errorFor("phone")}
        >
          {(c) => (
            <Input
              {...c}
              type="tel"
              name="phone"
              autoComplete="tel"
              dir="ltr"
              defaultValue={v.phone ?? ""}
            />
          )}
        </Field>
        <Field
          id={IDS.companyName ?? "ld-company"}
          label={optional(tc("details.companyName"))}
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
          id={IDS.vatId ?? "ld-vat"}
          label={optional(tc("details.vatId"))}
          error={errorFor("vatId")}
        >
          {(c) => (
            <Input {...c} name="vatId" dir="ltr" defaultValue={v.vatId ?? ""} />
          )}
        </Field>
      </fieldset>

      {props.disclosure}

      <fieldset className="flex flex-col gap-3">
        <legend className="mbe-2 text-xl">{tc("consent.legend")}</legend>
        <Checkbox
          id={IDS.terms ?? "ld-terms"}
          name="terms"
          label={tc("consent.terms")}
          required
          defaultChecked={v.terms === "on"}
          error={errorFor("terms")}
        />
        <Checkbox
          id={IDS.age ?? "ld-age"}
          name="age"
          label={tc("consent.age")}
          required
          defaultChecked={v.age === "on"}
          error={errorFor("age")}
        />
        {props.international ? (
          <Checkbox
            id={IDS.dap ?? "ld-dap"}
            name="dap"
            label={tc("consent.dap")}
            required
            defaultChecked={v.dap === "on"}
            error={errorFor("dap")}
          />
        ) : null}
        <Checkbox
          id="ld-receipt"
          name="receiptEmail"
          label={tc("consent.receiptEmail")}
          defaultChecked={
            values.current.receiptEmail
              ? values.current.receiptEmail === "on"
              : props.defaults.receiptEmail
          }
        />
      </fieldset>

      <p className="text-sm text-ink-muted">{tc("privacy")}</p>
      <div>
        <SubmitButton
          pendingLabel={tc("submitting")}
          data-testid="link-details-submit"
        >
          {t("submit")}
        </SubmitButton>
      </div>
    </form>
  );
}
