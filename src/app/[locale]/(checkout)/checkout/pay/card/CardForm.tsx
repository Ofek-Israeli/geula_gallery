"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { ErrorSummary, type FormErrorItem } from "@/components/ui/ErrorSummary";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  type CardBrand,
  checkCardNumber,
  checkCvc,
  checkExpiry,
  formatCardNumber,
  formatExpiry,
} from "@/lib/card";
import { isValidIsraeliId } from "@/lib/il-id";

/**
 * Our own card form (`/[locale]/checkout/pay/card`), shown while online card payment is not
 * active. It checks the card in the browser and sends nothing: the card inputs have no `name`, so
 * no form submission can carry them, nothing is stored, and a valid entry clears the card fields.
 * Connecting it to Isracard's processing later needs a PCI DSS review first (card data passing
 * through our pages and servers).
 */

type Problem = "number" | "expiry" | "cvc" | "name" | "socialId";

const IDS: Record<Problem, string> = {
  number: "cp-number",
  expiry: "cp-expiry",
  cvc: "cp-cvc",
  name: "cp-name",
  socialId: "cp-id",
};

export interface CardFormProps {
  payLabel: string;
  maxInstallments: number;
  contactHref: string;
}

export function CardForm(props: CardFormProps) {
  const t = useTranslations("checkout.card");
  const tc = useTranslations("checkout");
  const [problems, setProblems] = useState<Problem[]>([]);
  const [expired, setExpired] = useState(false);
  const [brand, setBrand] = useState<CardBrand | null>(null);
  const [done, setDone] = useState(false);
  const doneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const message = (p: Problem): string =>
    p === "expiry" && expired ? t("errors.expired") : t(`errors.${p}`);
  const error = (p: Problem) => (problems.includes(p) ? message(p) : undefined);
  // A new list only after a submit: the summary takes focus when it changes.
  const summary = useMemo<FormErrorItem[]>(
    () =>
      problems.map((p) => ({
        fieldId: IDS[p],
        message:
          p === "expiry" && expired ? t("errors.expired") : t(`errors.${p}`),
      })),
    [problems, expired, t],
  );

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const field = (p: Problem) =>
      form.elements.namedItem(IDS[p]) as HTMLInputElement | null;
    const value = (p: Problem) => field(p)?.value.trim() ?? "";
    const card = checkCardNumber(value("number"));
    const expiry = checkExpiry(value("expiry"), new Date());
    const list: Problem[] = [];
    if (!card.valid) list.push("number");
    if (expiry !== "ok") list.push("expiry");
    if (!checkCvc(value("cvc"), card.brand)) list.push("cvc");
    if (!value("name")) list.push("name");
    if (value("socialId") && !isValidIsraeliId(value("socialId"))) {
      list.push("socialId");
    }
    setExpired(expiry === "expired");
    setProblems(list);
    if (list.length > 0) {
      setDone(false);
      return;
    }
    // Card payment is not active: nothing is sent. The card details leave the page now.
    for (const p of ["number", "expiry", "cvc"] as const) {
      const input = field(p);
      if (input) input.value = "";
    }
    setBrand(null);
    setDone(true);
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className="flex flex-col gap-5"
      data-testid="card-form"
    >
      <ErrorSummary errors={summary} />
      {done ? (
        <div
          ref={doneRef}
          tabIndex={-1}
          role="status"
          className="flex flex-col gap-1 rounded-sm border-2 border-ink bg-white p-4"
          data-testid="card-done"
        >
          <p className="font-semibold">{t("doneTitle")}</p>
          <p>
            {t("doneBody")}{" "}
            <a href={props.contactHref} className="underline">
              {t("doneContact")}
            </a>
          </p>
        </div>
      ) : null}

      <fieldset className="flex flex-col gap-4">
        <legend className="mbe-2 text-xl">{t("cardTitle")}</legend>
        <div className="flex flex-col gap-1">
          <Field
            id={IDS.number}
            label={t("number")}
            required
            error={error("number")}
          >
            {(c) => (
              <Input
                {...c}
                inputMode="numeric"
                autoComplete="cc-number"
                dir="ltr"
                maxLength={23}
                spellCheck={false}
                autoCorrect="off"
                onChange={(e) => {
                  const check = checkCardNumber(e.currentTarget.value);
                  setBrand(check.valid ? check.brand : null);
                }}
                onBlur={(e) => {
                  e.currentTarget.value = formatCardNumber(
                    e.currentTarget.value,
                  );
                }}
              />
            )}
          </Field>
          <p
            aria-live="polite"
            className="min-h-5 text-sm text-ink-muted"
            data-testid="card-brand"
          >
            {brand ? t("brand", { brand: tc(`cards.${brand}`) }) : null}
          </p>
        </div>
        {/* Bottom-aligned: the CVV hint would otherwise push its input below the expiry's. */}
        <div className="grid gap-4 sm:grid-cols-2 sm:items-end">
          <Field
            id={IDS.expiry}
            label={t("expiry")}
            required
            error={error("expiry")}
          >
            {(c) => (
              <Input
                {...c}
                inputMode="numeric"
                autoComplete="cc-exp"
                dir="ltr"
                maxLength={7}
                placeholder="MM/YY"
                onBlur={(e) => {
                  e.currentTarget.value = formatExpiry(e.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Field
            id={IDS.cvc}
            label={t("cvc")}
            hint={t("cvcHint")}
            required
            error={error("cvc")}
          >
            {(c) => (
              <Input
                {...c}
                inputMode="numeric"
                autoComplete="cc-csc"
                dir="ltr"
                maxLength={4}
                spellCheck={false}
              />
            )}
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mbe-2 text-xl">{t("holderTitle")}</legend>
        <Field id={IDS.name} label={t("name")} required error={error("name")}>
          {(c) => <Input {...c} autoComplete="cc-name" />}
        </Field>
        <Field
          id={IDS.socialId}
          label={t("socialId")}
          hint={t("socialIdHint")}
          error={error("socialId")}
        >
          {(c) => (
            <Input
              {...c}
              inputMode="numeric"
              dir="ltr"
              maxLength={11}
              autoComplete="off"
            />
          )}
        </Field>
        {props.maxInstallments > 1 ? (
          <Field id="cp-installments" label={t("installments")}>
            {(c) => (
              <Select
                {...c}
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
        ) : null}
      </fieldset>

      <div>
        <button
          type="submit"
          className={buttonClasses("primary")}
          data-testid="card-submit"
        >
          {props.payLabel}
        </button>
      </div>
    </form>
  );
}
