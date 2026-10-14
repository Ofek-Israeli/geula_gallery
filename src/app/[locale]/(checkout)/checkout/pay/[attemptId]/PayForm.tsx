"use client";

import Script from "next/script";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { controlClasses, Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";
import type { ActionState } from "@/server/next/actions";
import type { ChargeOutcome } from "@/server/payments/charge";

/**
 * The card form of the Isracard pay page. Card number, expiry and CVV are PayMe's hosted fields
 * (iframes from hf.payme.io): what the buyer types there goes from the browser to Isracard and
 * never reaches our servers. Name, ID number, email and phone are our own inputs, passed to the
 * tokenization. The one-time token, the 3-D Secure client data, the ID number and the installments
 * go to `payWithCardAction`; its answer is opened with a full page load (the order page, a 3-D
 * Secure challenge or a new pay page after a decline).
 */

interface PaymeField {
  mount(selector: string): void;
  on(
    event: string,
    cb: (e: { isValid?: boolean; message?: string }) => void,
  ): void;
  teardown?(): void;
}
interface PaymeInstance {
  hostedFields(): {
    create(field: string, options?: Record<string, unknown>): PaymeField;
  };
  tokenize(data: Record<string, unknown>): Promise<{ token?: string }>;
}
interface PaymeGlobal {
  create(
    key: string,
    options: { testMode: boolean; language: Locale; tokenIsPermanent: boolean },
  ): Promise<PaymeInstance>;
  clientData?(testMode: boolean): Promise<{ hash?: string }>;
}
declare global {
  interface Window {
    PayMe?: PaymeGlobal;
  }
}

type State = ActionState<ChargeOutcome>;

export interface PayFormProps {
  action: (prev: State, payload: FormData) => Promise<State>;
  locale: Locale;
  attemptId: string;
  token: string;
  client: { apiKey: string; testMode: boolean; scriptUrl: string };
  nonce?: string;
  amount: { value: string; currency: string; label: string };
  payLabel: string;
  maxInstallments: number;
  prefill: { name: string; email: string; phone: string } | null;
}

const CARD_FIELDS = [
  { field: "cardNumber", id: "pm-card-number", label: "cardNumber" },
  { field: "cardExpiration", id: "pm-card-expiry", label: "expiry" },
  { field: "cvc", id: "pm-card-cvc", label: "cvc" },
] as const;

/** Only PayMe's whitelisted properties (color, font-size, text-align, letter-spacing…). */
const FIELD_STYLES = {
  base: {
    color: "#1d1c1a",
    "font-size": "17px",
    "::placeholder": { color: "#5e5a53" },
  },
  invalid: { color: "#b4231a" },
  valid: { color: "#1d1c1a" },
};

function splitName(full: string): [string, string] {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return [full.trim(), ""];
  return [parts.slice(0, -1).join(" "), parts.at(-1) ?? ""];
}

export function PayForm(props: PayFormProps) {
  const t = useTranslations("checkout.pay");
  const instance = useRef<PaymeInstance | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [first, last] = props.prefill
    ? splitName(props.prefill.name)
    : ["", ""];

  // Reached by a client-router navigation, the page would still run under the previous page's
  // CSP (no hosted fields): reload once, which applies this page's own policy.
  useEffect(() => {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav && new URL(nav.name).pathname !== window.location.pathname) {
      window.location.replace(window.location.href);
    }
  }, []);

  useEffect(() => {
    if (!scriptReady || !window.PayMe) return;
    let cancelled = false;
    const fields: PaymeField[] = [];
    window.PayMe.create(props.client.apiKey, {
      testMode: props.client.testMode,
      language: props.locale,
      tokenIsPermanent: false,
    })
      .then((created) => {
        if (cancelled) return;
        instance.current = created;
        const manager = created.hostedFields();
        for (const f of CARD_FIELDS) {
          const field = manager.create(f.field, { styles: FIELD_STYLES });
          field.mount(`#${f.id}`);
          field.on("validity-changed", (e) =>
            setInvalid((prev) => {
              const next = { ...prev };
              if (e.isValid === false && e.message) next[f.field] = e.message;
              else delete next[f.field];
              return next;
            }),
          );
          fields.push(field);
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
      for (const f of fields) f.teardown?.();
      instance.current = null;
      setReady(false);
    };
  }, [scriptReady, props.client.apiKey, props.client.testMode, props.locale]);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const created = instance.current;
      if (!created || busy) return;
      setBusy(true);
      setError(null);
      const form = new FormData(event.currentTarget);
      const value = (name: string) => String(form.get(name) ?? "").trim();
      try {
        const result = await created.tokenize({
          payerFirstName: value("firstName"),
          payerLastName: value("lastName"),
          payerEmail: value("email"),
          payerPhone: value("phone"),
          payerSocialId: value("socialId"),
          total: {
            label: props.amount.label,
            amount: {
              currency: props.amount.currency,
              value: props.amount.value,
            },
          },
        });
        if (!result.token) throw new Error("no token");
        let clientData = "";
        try {
          clientData =
            (await window.PayMe?.clientData?.(props.client.testMode))?.hash ??
            "";
        } catch {
          clientData = "";
        }
        const payload = new FormData();
        payload.set(LOCALE_FIELD, props.locale);
        payload.set("attemptId", props.attemptId);
        payload.set("t", props.token);
        payload.set("token", result.token);
        if (clientData) payload.set("clientData", clientData);
        if (value("socialId")) payload.set("socialId", value("socialId"));
        payload.set("installments", value("installments") || "1");
        const state = await props.action(null, payload);
        if (state?.ok && state.data.kind === "navigate") {
          window.location.assign(state.data.url);
          return;
        }
        setError(
          state && !state.ok && state.error.code === "RATE_LIMITED"
            ? t("errors.rateLimited")
            : state?.ok && state.data.kind === "error"
              ? t(`errors.${state.data.code}`)
              : t("errors.generic"),
        );
      } catch {
        // A tokenization error: PayMe's field messages say which detail is wrong.
        setError(t("errors.card"));
      }
      setBusy(false);
    },
    [busy, props, t],
  );

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-5"
      data-testid="pay-form"
    >
      <Script
        src={props.client.scriptUrl}
        strategy="afterInteractive"
        nonce={props.nonce}
        onReady={() => setScriptReady(true)}
        onError={() => setLoadFailed(true)}
      />
      {error ? (
        <div
          role="alert"
          className="rounded-sm border-2 border-reddot bg-white p-4"
          data-testid="pay-error"
        >
          {error}
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-4">
        <legend className="mbe-2 text-xl">{t("cardTitle")}</legend>
        {loadFailed ? (
          <p role="alert" data-testid="pay-load-failed">
            {t("loadFailed")}
          </p>
        ) : !ready ? (
          <p role="status" className="text-sm text-ink-muted">
            {t("loading")}
          </p>
        ) : null}
        {CARD_FIELDS.map((f) => (
          <fieldset key={f.id} className="flex flex-col gap-1">
            <legend className="mbe-1 font-medium">{t(f.label)}</legend>
            {/* PayMe mounts its iframe here; what is typed goes to Isracard only. */}
            <div
              id={f.id}
              className={`${controlClasses} flex items-center [&>iframe]:h-7 [&>iframe]:w-full`}
              dir="ltr"
              data-testid={f.id}
            />
            {invalid[f.field] ? (
              <p className="text-sm font-medium text-reddot">
                {invalid[f.field]}
              </p>
            ) : null}
          </fieldset>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mbe-2 text-xl">{t("holderTitle")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="pm-first" label={t("firstName")} required>
            {(c) => (
              <Input
                {...c}
                name="firstName"
                autoComplete="cc-given-name"
                defaultValue={first}
              />
            )}
          </Field>
          <Field id="pm-last" label={t("lastName")} required>
            {(c) => (
              <Input
                {...c}
                name="lastName"
                autoComplete="cc-family-name"
                defaultValue={last}
              />
            )}
          </Field>
        </div>
        <Field id="pm-social" label={t("socialId")} hint={t("socialIdHint")}>
          {(c) => (
            <Input
              {...c}
              name="socialId"
              inputMode="numeric"
              dir="ltr"
              maxLength={9}
              autoComplete="off"
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="pm-email" label={t("email")} required>
            {(c) => (
              <Input
                {...c}
                type="email"
                name="email"
                autoComplete="email"
                defaultValue={props.prefill?.email ?? ""}
              />
            )}
          </Field>
          <Field id="pm-phone" label={t("phone")} required>
            {(c) => (
              <Input
                {...c}
                type="tel"
                name="phone"
                autoComplete="tel"
                defaultValue={props.prefill?.phone ?? ""}
              />
            )}
          </Field>
        </div>
        {props.maxInstallments > 1 ? (
          <Field id="pm-installments" label={t("installments")}>
            {(c) => (
              <Select
                {...c}
                name="installments"
                defaultValue="1"
                options={Array.from(
                  { length: props.maxInstallments },
                  (_, i) => i + 1,
                ).map((n) => ({
                  value: String(n),
                  label: t("installmentsOption", { count: n }),
                }))}
              />
            )}
          </Field>
        ) : (
          <input type="hidden" name="installments" value="1" />
        )}
      </fieldset>

      <div>
        <button
          type="submit"
          disabled={!ready || busy}
          aria-disabled={!ready || busy ? true : undefined}
          className={buttonClasses("primary")}
          data-testid="pay-submit"
        >
          {busy ? t("submitting") : props.payLabel}
        </button>
      </div>
    </form>
  );
}
