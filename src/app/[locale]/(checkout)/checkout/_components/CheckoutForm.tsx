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
import { FORM_START_FIELD, LOCALE_FIELD } from "@/lib/forms";
import type { Locale } from "@/lib/locale";
import type { ActionState } from "@/server/next/actions";
import type { CheckoutActionData } from "../_lib/start-input";

type State = ActionState<CheckoutActionData>;

export interface CheckoutFormProps {
  action: (prev: State, formData: FormData) => Promise<State>;
  locale: Locale;
  hidden: {
    /** "Buy now": the work's slug. The cart checkout posts `items` instead. */
    slug?: string;
    /** Cart lines `"<artwork id>:<price minor>"`, each posted as an `item` field. */
    items?: string[];
    country: string;
    method: string;
    currency: string;
    /** "ROLLED" when the buyer chose the works rolled in a tube (step 2). */
    packing?: "ROLLED";
    /** From the destination step; posted only for a delivery (a pickup posts neither). */
    city?: string;
    postalCode?: string;
    expectedTotalMinor: number;
    clientRequestId: string;
    formStart: string;
  };
  /** The destination chosen in step 1, shown under the street address. */
  destination: { city: string; postalCode: string; countryName: string };
  needsAddress: boolean;
  international: boolean;
  holdMinutes: number;
  /** Works in this checkout (the hold notice says "the work" or "the N works"). */
  itemCount: number;
  /** Titles by artwork id, so an error can name the works another buyer took. */
  itemTitles?: Record<string, string>;
  /**
   * The payment methods the quote offers. Empty only in the preview (`CHECKOUT_PREVIEW`) before a
   * provider is configured: the payment step then says "activation pending" and cannot submit.
   */
  providers: { id: string; label: string; description?: string }[];
  /** Locale-prefixed contact page, for "buy a work now" while payments are pending. */
  contactHref: string;
  /** `PAYMENT_CARD_BRANDS`: the card brands named under the payment methods (none when empty). */
  cardBrands: readonly string[];
  /** The rendered pre-contract disclosure (server component output). */
  disclosure: ReactNode;
  /** Locale-prefixed: the same choices, as far as they go ("show the updated total"). */
  reloadHref: string;
  /** Locale-prefixed: step 1, prefilled. */
  changeDestinationHref: string;
}

const FIELD_IDS: Record<string, string> = {
  name: "co-name",
  email: "co-email",
  phone: "co-phone",
  line1: "co-line1",
  line2: "co-line2",
  region: "co-region",
  companyName: "co-company",
  vatId: "co-vat",
  terms: "co-terms",
  dap: "co-dap",
  providerId: "co-provider",
};

/** Fields set in step 1: an error on them sends the buyer back there. */
const DESTINATION_FIELDS = new Set(["country", "city", "postalCode"]);

/**
 * The checkout details form (step 3, spec §5.1 step 2): buyer details, the street address for a
 * delivery (Latin abroad; city and postal code come from step 1), the pre-contract disclosure,
 * the unticked consent checkboxes, the provider radios and the hold notice. Country, method,
 * currency and destination are hidden fields from the page's URL, so what is posted is what the
 * page priced. With JavaScript the values survive a failed submit.
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
      const next = await props.action(prev, formData);
      // Our own pay page opens with a full page load (its own CSP), started here: the page under
      // the form may re-render before an effect would run.
      if (next?.ok && next.data.kind === "navigate") {
        window.location.assign(next.data.url);
      }
      return next;
    },
    null,
  );
  const v = values.current;
  const paymentsPending = props.providers.length === 0;
  /** Isracard's card page comes next (or will, once activated): say what it asks for. */
  const isracardNext =
    paymentsPending || props.providers.some((p) => p.id === "isracard");
  const navigateTo =
    state?.ok && state.data.kind === "navigate" ? state.data.url : null;
  /** Optional fields say so. */
  const optional = (label: string): ReactNode => (
    <>
      {label}
      <span className="ms-1 font-normal text-ink-muted">{tf("optional")}</span>
    </>
  );
  const fieldErrors = state && !state.ok ? (state.error.fieldErrors ?? {}) : {};
  const errorFor = (name: string): string | undefined => {
    const list = fieldErrors[name];
    if (!list?.length) return undefined;
    if (["terms", "dap"].includes(name)) return t("consent.required");
    return list[0] === "required" ? tf("invalid") : list[0];
  };

  const summary: FormErrorItem[] = [];
  let banner: ReactNode = null;
  if (state && !state.ok) {
    const code = state.error.code;
    if (code === "INVALID_INPUT") {
      const destinationError = Object.keys(fieldErrors).some(
        (name) => DESTINATION_FIELDS.has(name) && fieldErrors[name]?.length,
      );
      for (const name of Object.keys(fieldErrors)) {
        if (DESTINATION_FIELDS.has(name)) continue;
        const message = errorFor(name);
        if (message) summary.push({ fieldId: FIELD_IDS[name], message });
      }
      if (destinationError) {
        banner = (
          <>
            {t("errors.destination")}{" "}
            <a href={props.changeDestinationHref} className="underline">
              {t("steps.changeDestination")}
            </a>
          </>
        );
      } else if (summary.length === 0) {
        summary.push({ message: t("errors.fix") });
      }
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
      const titles = (d.artworkIds ?? [])
        .map((id) => props.itemTitles?.[id])
        .filter((x): x is string => Boolean(x));
      banner =
        props.itemCount > 1 && titles.length > 0
          ? t("errors.just_reserved_items", {
              titles: titles.join(", "),
              count: titles.length,
            })
          : t("errors.just_reserved");
    } else if (d.kind === "refused") {
      const key = `errors.${d.code}`;
      banner = t.has(key as never) ? t(key as never) : t("errors.generic");
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
      {h.slug !== undefined ? (
        <input type="hidden" name="slug" value={h.slug} />
      ) : null}
      {(h.items ?? []).map((item) => (
        <input key={item} type="hidden" name="item" value={item} />
      ))}
      <input type="hidden" name="country" value={h.country} />
      <input type="hidden" name="method" value={h.method} />
      <input type="hidden" name="currency" value={h.currency} />
      {h.packing ? (
        <input type="hidden" name="packing" value={h.packing} />
      ) : null}
      {h.city !== undefined ? (
        <input type="hidden" name="city" value={h.city} />
      ) : null}
      {h.postalCode !== undefined ? (
        <input type="hidden" name="postalCode" value={h.postalCode} />
      ) : null}
      <input
        type="hidden"
        name="expectedTotalMinor"
        value={String(h.expectedTotalMinor)}
      />
      <input type="hidden" name="clientRequestId" value={h.clientRequestId} />
      <HoneypotField />

      {navigateTo ? (
        <p role="status" className="font-medium" data-testid="checkout-opening">
          {t("opening")}
        </p>
      ) : null}
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
              ["region", "address-level1", false],
            ] as const
          ).map(([name, auto, req]) => (
            <Field
              key={name}
              id={FIELD_IDS[name] ?? name}
              label={
                req ? t(`details.${name}`) : optional(t(`details.${name}`))
              }
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
          <p
            className="text-sm text-ink-muted"
            data-testid="details-destination"
          >
            {t("details.cityAndPostal")}:{" "}
            <bdi dir="auto">{props.destination.city}</bdi>
            {props.destination.postalCode ? (
              <>
                {" "}
                <bdi dir="ltr">{props.destination.postalCode}</bdi>
              </>
            ) : null}
            {", "}
            {props.destination.countryName}
          </p>
        </fieldset>
      ) : (
        <p className="text-sm text-ink-muted">{t("details.pickupNote")}</p>
      )}

      <fieldset className="flex flex-col gap-4">
        <legend className="mbe-1 text-xl">{t("details.receiptTitle")}</legend>
        <p className="text-sm text-ink-muted">{t("details.receiptHint")}</p>
        <Field
          id={FIELD_IDS.companyName ?? "co-company"}
          label={optional(t("details.companyName"))}
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
          label={optional(t("details.vatId"))}
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

      {paymentsPending ? (
        <div className="flex flex-col gap-2" data-testid="payments-pending">
          {/* Not a form field: nothing is posted, and the submit stays disabled. */}
          <RadioGroup
            id="co-provider-pending"
            name="providerPending"
            legend={t("provider.legend")}
            options={[
              {
                value: "isracard",
                label: t("provider.isracard"),
                description: t("provider.pendingDescription"),
                disabled: true,
              },
            ]}
          />
          <p className="max-w-prose text-sm">
            {t("provider.pendingNote")}{" "}
            <a href={props.contactHref} className="underline">
              {t("provider.pendingContact")}
            </a>
          </p>
        </div>
      ) : (
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
      )}

      {isracardNext ? (
        <div
          className="flex max-w-prose flex-col gap-1 rounded-sm border border-line p-4 text-sm"
          data-testid="checkout-card-page"
        >
          <p className="font-medium">{t("cardPage.title")}</p>
          <ul className="list-disc ps-5">
            <li>{t("cardPage.secureFields")}</li>
            <li>{t("cardPage.holder")}</li>
            <li>{t("cardPage.contact")}</li>
          </ul>
        </div>
      ) : null}

      <section
        aria-labelledby="co-secure-title"
        className="flex flex-col gap-2 border-s-2 border-line ps-4"
        data-testid="checkout-secure"
      >
        <h2 id="co-secure-title" className="text-lg font-medium">
          {t("secure.title")}
        </h2>
        <p className="max-w-prose text-sm">{t("secure.body")}</p>
        {props.cardBrands.length > 0 ? (
          <p className="text-sm" data-testid="checkout-cards">
            {t("secure.cards")}{" "}
            {props.cardBrands.map((b, i) => (
              <span key={b}>
                {i > 0 ? " · " : null}
                <span className="font-medium">{t(`cards.${b}` as never)}</span>
              </span>
            ))}
          </p>
        ) : null}
      </section>

      <p className="text-sm text-ink-muted">{t("privacy")}</p>
      {paymentsPending ? null : (
        <p className="font-medium">
          {t("holdNotice", {
            minutes: props.holdMinutes,
            count: props.itemCount,
          })}
        </p>
      )}
      <div>
        <SubmitButton
          pendingLabel={t("submitting")}
          disabled={paymentsPending}
          aria-describedby={paymentsPending ? "co-submit-pending" : undefined}
          data-testid="checkout-submit"
        >
          {t("submit")}
        </SubmitButton>
      </div>
      {paymentsPending ? (
        <p id="co-submit-pending" className="text-sm text-ink-muted">
          {t("cardPage.pendingButton")}
        </p>
      ) : (
        <p className="text-sm text-ink-muted">{t("provider.redirectNote")}</p>
      )}
    </form>
  );
}
