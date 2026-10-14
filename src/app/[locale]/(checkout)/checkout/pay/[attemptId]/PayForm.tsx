"use client";

import Script from "next/script";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { ErrorSummary, type FormErrorItem } from "@/components/ui/ErrorSummary";
import { Field } from "@/components/ui/Field";
import { controlClasses, Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";
import type { ActionState } from "@/server/next/actions";
import type { ChargeOutcome } from "@/server/payments/charge";
import {
  CARD_FIELDS,
  type CardField,
  checkHolder,
  HOLDER_FIELDS,
  type HolderField,
  tokenizeFailure,
} from "./holder";

/**
 * The card form of the Isracard pay page. Card number, expiry and CVV are PayMe's hosted fields
 * (iframes from hf.payme.io): what the buyer types there goes from the browser to Isracard and
 * never reaches our servers. Name, ID number, email and phone are our own inputs, checked here
 * (`holder.ts`) and passed to the tokenization. The one-time token, the 3-D Secure client data,
 * the ID number and the installments go to `payWithCardAction`; its answer is opened with a full
 * page load (the order page, a 3-D Secure challenge or a new pay page after a decline). A token
 * is good for one try: after any other answer the card fields are created again.
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
type Problem = HolderField | CardField;

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

/** Our ids for each field: the card fields' containers and our own inputs. */
const FIELD_IDS: Record<Problem, string> = {
  cardNumber: "pm-card-number",
  cardExpiration: "pm-card-expiry",
  cvc: "pm-card-cvc",
  firstName: "pm-first",
  lastName: "pm-last",
  socialId: "pm-social",
  email: "pm-email",
  phone: "pm-phone",
};
const CARD_LABELS: Record<CardField, "cardNumber" | "expiry" | "cvc"> = {
  cardNumber: "cardNumber",
  cardExpiration: "expiry",
  cvc: "cvc",
};
/** Page order, for the error summary. */
const PAGE_ORDER: readonly Problem[] = [...CARD_FIELDS, ...HOLDER_FIELDS];

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

/**
 * The three hosted card fields of one PayMe session. Remounted (a new `key`) to start a new
 * session: its cleanup tears the iframes down.
 */
function CardFields({
  scriptReady,
  client,
  locale,
  instance,
  onReady,
  onLoadFailed,
  errors,
}: {
  scriptReady: boolean;
  client: PayFormProps["client"];
  locale: Locale;
  instance: React.RefObject<PaymeInstance | null>;
  onReady: (ready: boolean) => void;
  onLoadFailed: () => void;
  errors: Partial<Record<CardField, string>>;
}) {
  const t = useTranslations("checkout.pay");
  const [live, setLive] = useState<Partial<Record<CardField, string>>>({});

  useEffect(() => {
    if (!scriptReady || !window.PayMe) return;
    let cancelled = false;
    const fields: PaymeField[] = [];
    window.PayMe.create(client.apiKey, {
      testMode: client.testMode,
      language: locale,
      tokenIsPermanent: false,
    })
      .then((created) => {
        if (cancelled) return;
        instance.current = created;
        const manager = created.hostedFields();
        for (const f of CARD_FIELDS) {
          const field = manager.create(f, { styles: FIELD_STYLES });
          field.mount(`#${FIELD_IDS[f]}`);
          field.on("validity-changed", (e) =>
            setLive((prev) => {
              const next = { ...prev };
              if (e.isValid === false && e.message) next[f] = e.message;
              else delete next[f];
              return next;
            }),
          );
          fields.push(field);
        }
        onReady(true);
      })
      .catch(() => {
        if (!cancelled) onLoadFailed();
      });
    return () => {
      cancelled = true;
      for (const f of fields) f.teardown?.();
      instance.current = null;
      onReady(false);
    };
  }, [
    scriptReady,
    client.apiKey,
    client.testMode,
    locale,
    instance,
    onReady,
    onLoadFailed,
  ]);

  return CARD_FIELDS.map((f) => {
    const message = live[f] ?? errors[f];
    return (
      <fieldset key={f} className="flex flex-col gap-1">
        <legend className="mbe-1 font-medium">{t(CARD_LABELS[f])}</legend>
        {/* PayMe mounts its iframe here; what is typed goes to Isracard only. */}
        <div
          id={FIELD_IDS[f]}
          tabIndex={-1}
          className={`${controlClasses} flex items-center [&>iframe]:h-7 [&>iframe]:w-full ${message ? "border-reddot" : ""}`}
          dir="ltr"
          data-testid={FIELD_IDS[f]}
        />
        {message ? (
          <p className="text-sm font-medium text-reddot">{message}</p>
        ) : null}
      </fieldset>
    );
  });
}

export function PayForm(props: PayFormProps) {
  const t = useTranslations("checkout.pay");
  const instance = useRef<PaymeInstance | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  /** Bumped to create the card fields again (a new one-time session). */
  const [session, setSession] = useState(0);
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

  const onLoadFailed = useCallback(() => setLoadFailed(true), []);
  const has = (p: Problem) => problems.includes(p);
  const message = (p: Problem) => t(`fieldErrors.${p}`);
  const report = (list: Problem[]) =>
    setProblems(PAGE_ORDER.filter((p) => list.includes(p)));
  // A new list only when a submit reports problems: the summary takes focus when it changes.
  const summary = useMemo<FormErrorItem[]>(
    () =>
      problems.map((p) => ({
        fieldId: FIELD_IDS[p],
        message: t(`fieldErrors.${p}`),
      })),
    [problems, t],
  );
  const cardErrors = Object.fromEntries(
    CARD_FIELDS.filter(has).map((f) => [f, message(f)]),
  ) as Partial<Record<CardField, string>>;
  /** The token was used (or the session ended): new card fields for the next try. */
  const newSession = () => setSession((n) => n + 1);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = instance.current;
    if (!created || busy) return;
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? "").trim();
    setError(null);
    const holder = checkHolder({
      firstName: value("firstName"),
      lastName: value("lastName"),
      socialId: value("socialId"),
      email: value("email"),
      phone: value("phone"),
    });
    report(holder.problems);
    if (holder.problems.length > 0) return;

    setBusy(true);
    let token: string;
    try {
      const result = await created.tokenize({
        payerFirstName: value("firstName"),
        payerLastName: value("lastName"),
        payerEmail: value("email"),
        payerPhone: value("phone"),
        ...(holder.socialId ? { payerSocialId: holder.socialId } : {}),
        total: {
          label: props.amount.label,
          amount: {
            currency: props.amount.currency,
            value: props.amount.value,
          },
        },
      });
      if (!result.token) throw new Error("no token");
      token = result.token;
    } catch (e) {
      const failure = tokenizeFailure(e);
      if (failure.kind === "fields") report(failure.fields);
      else if (failure.kind === "session") {
        setError(t("sessionExpired"));
        newSession();
      } else setError(t("errors.card"));
      setBusy(false);
      return;
    }

    let clientData = "";
    try {
      clientData =
        (await window.PayMe?.clientData?.(props.client.testMode))?.hash ?? "";
    } catch {
      clientData = "";
    }
    const payload = new FormData();
    payload.set(LOCALE_FIELD, props.locale);
    payload.set("attemptId", props.attemptId);
    payload.set("t", props.token);
    payload.set("token", token);
    if (clientData) payload.set("clientData", clientData);
    if (holder.socialId) payload.set("socialId", holder.socialId);
    payload.set("installments", value("installments") || "1");
    let state: State = null;
    try {
      state = await props.action(null, payload);
    } catch {
      state = null;
    }
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
    newSession();
    setBusy(false);
  }

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
        onError={onLoadFailed}
      />
      <ErrorSummary errors={summary} />
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
        <CardFields
          key={session}
          scriptReady={scriptReady}
          client={props.client}
          locale={props.locale}
          instance={instance}
          onReady={setReady}
          onLoadFailed={onLoadFailed}
          errors={cardErrors}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mbe-2 text-xl">{t("holderTitle")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={FIELD_IDS.firstName}
            label={t("firstName")}
            required
            error={has("firstName") ? message("firstName") : undefined}
          >
            {(c) => (
              <Input
                {...c}
                name="firstName"
                autoComplete="cc-given-name"
                defaultValue={first}
              />
            )}
          </Field>
          <Field
            id={FIELD_IDS.lastName}
            label={t("lastName")}
            required
            error={has("lastName") ? message("lastName") : undefined}
          >
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
        <Field
          id={FIELD_IDS.socialId}
          label={t("socialId")}
          hint={t("socialIdHint")}
          error={has("socialId") ? message("socialId") : undefined}
        >
          {(c) => (
            <Input
              {...c}
              name="socialId"
              inputMode="numeric"
              dir="ltr"
              maxLength={11}
              autoComplete="off"
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={FIELD_IDS.email}
            label={t("email")}
            required
            error={has("email") ? message("email") : undefined}
          >
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
          <Field
            id={FIELD_IDS.phone}
            label={t("phone")}
            required
            error={has("phone") ? message("phone") : undefined}
          >
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
