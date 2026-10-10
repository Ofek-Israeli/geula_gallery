import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { ErrorSummary, type FormErrorItem } from "@/components/ui/ErrorSummary";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Price } from "@/components/ui/Price";
import { Select } from "@/components/ui/Select";
import { Link } from "@/i18n/navigation";
import {
  CHECKOUT_STEPS,
  type CheckoutStep,
  type DeliveryProblem,
  type StepLinks,
} from "@/lib/checkout-steps";
import { type CountryOption, postalCodeRequired } from "@/lib/countries";
import { cx } from "@/lib/cx";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import {
  DESTINATION_LIMITS,
  type DestinationField,
  type DestinationIssue,
  type DestinationIssues,
} from "@/lib/validation/destination";
import { VALIDATION_MESSAGES } from "@/lib/validation/messages";
import {
  DeliveryNotices,
  MethodChoices,
  methodName,
  methodPriceLabel,
  type OkQuote,
} from "./parts";

/**
 * The address-first checkout's steps (`src/lib/checkout-steps.ts`), shared by "Buy now" and the
 * cart checkout: the progress list, step 1 (destination GET form), step 2 (recap, currency links,
 * delivery GET form) and the top of step 3 (recap with "Change" links). Both GET forms work
 * without JavaScript, and the server validates every step (the forms are `noValidate`).
 */

/** The destination as the steps show it. */
export interface DestinationView {
  country: string;
  countryName: string;
  city: string;
  zip: string;
}

const DESTINATION_FIELDS = ["country", "city", "postalCode"] as const;

/** Step 1's control ids (also the error summary's targets). `co-country` is relied on by specs. */
const FIELD_IDS: Record<DestinationField, string> = {
  country: "co-country",
  city: "co-city",
  postalCode: "co-postal",
};

/** Texts for step 1's issues; Latin-script and country texts match the details form's. */
async function destinationErrorTexts(
  issues: DestinationIssues,
  locale: Locale,
): Promise<Partial<Record<DestinationField, string>>> {
  const t = await getTranslations({ locale, namespace: "checkout" });
  const text = (field: DestinationField, issue: DestinationIssue): string => {
    if (issue === "latin_only") return VALIDATION_MESSAGES.latin_only[locale];
    if (issue === "too_long") {
      return t("destination.errors.tooLong", {
        max:
          field === "postalCode"
            ? DESTINATION_LIMITS.postalCode
            : DESTINATION_LIMITS.city,
      });
    }
    if (issue === "required" && field === "city") {
      return t("destination.errors.cityRequired");
    }
    if (issue === "required" && field === "postalCode") {
      return t("destination.errors.postalRequired");
    }
    return VALIDATION_MESSAGES.invalid_country[locale];
  };
  const out: Partial<Record<DestinationField, string>> = {};
  for (const field of DESTINATION_FIELDS) {
    const issue = issues[field];
    if (issue) out[field] = text(field, issue);
  }
  return out;
}

/** The progress list: three steps, the current one marked with `aria-current="step"`. */
export async function CheckoutSteps({
  current,
  locale,
}: {
  current: CheckoutStep;
  locale: Locale;
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  const at = CHECKOUT_STEPS.indexOf(current);
  return (
    <ol
      aria-label={t("steps.label")}
      className="flex flex-wrap gap-x-6 gap-y-2 text-sm"
      data-testid="checkout-steps"
    >
      {CHECKOUT_STEPS.map((s, i) => (
        <li
          key={s}
          aria-current={i === at ? "step" : undefined}
          className={cx(
            "flex items-center gap-2",
            i === at ? "font-semibold" : i > at ? "text-ink-muted" : null,
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              "inline-flex size-6 items-center justify-center rounded-full border text-xs",
              i === at ? "border-ink bg-ink text-paper" : "border-line",
            )}
          >
            {i + 1}
          </span>
          {t(`steps.${s}`)}
        </li>
      ))}
    </ol>
  );
}

export interface DestinationFormProps {
  /** The checkout page's locale-prefixed path. */
  action: string;
  locale: Locale;
  countries: readonly CountryOption[];
  value: { country: string; city: string; zip: string };
  /** Kept through step 1 so "Change destination" does not forget the method or currency. */
  carry: { ship: string | null; cur: "USD" | null };
  /** Shown inline (empty on arrival and after "Change"). */
  issues: DestinationIssues;
}

/** Step 1's GET form: country, city and postal code; it asks for step 2. */
export async function DestinationForm({
  action,
  locale,
  countries,
  value,
  carry,
  issues,
}: DestinationFormProps) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  const tf = await getTranslations({ locale, namespace: "common.form" });
  const errors = await destinationErrorTexts(issues, locale);
  const postalRequired = postalCodeRequired(value.country);
  return (
    <form
      method="get"
      action={action}
      noValidate
      className="flex flex-col gap-4"
      data-testid="destination-form"
    >
      <Field
        id={FIELD_IDS.country}
        label={t("destination.country")}
        required
        error={errors.country}
      >
        {(c) => (
          <Select
            {...c}
            name="to"
            autoComplete="country"
            defaultValue={value.country}
            options={countries.map((o) => ({ value: o.code, label: o.name }))}
          />
        )}
      </Field>
      <Field
        id={FIELD_IDS.city}
        label={t("details.city")}
        hint={t("details.latinHint")}
        required
        error={errors.city}
      >
        {(c) => (
          <Input
            {...c}
            name="city"
            autoComplete="address-level2"
            defaultValue={value.city}
          />
        )}
      </Field>
      <Field
        id={FIELD_IDS.postalCode}
        label={
          postalRequired ? (
            t("details.postalCode")
          ) : (
            <>
              {t("details.postalCode")}
              <span className="ms-1 font-normal text-ink-muted">
                {tf("optional")}
              </span>
            </>
          )
        }
        hint={t("destination.postalHint")}
        required={postalRequired}
        error={errors.postalCode}
      >
        {(c) => (
          <Input
            {...c}
            name="zip"
            autoComplete="postal-code"
            defaultValue={value.zip}
          />
        )}
      </Field>
      {carry.ship ? (
        <input type="hidden" name="ship" value={carry.ship} />
      ) : null}
      {carry.cur ? <input type="hidden" name="cur" value={carry.cur} /> : null}
      <input type="hidden" name="step" value="delivery" />
      <div>
        <button
          type="submit"
          className={buttonClasses("primary")}
          data-testid="destination-continue"
        >
          {t("steps.continue")}
        </button>
      </div>
    </form>
  );
}

/** Step 1: where to (with an error summary when the buyer asked to move on). */
export async function DestinationStep(props: DestinationFormProps) {
  const t = await getTranslations({
    locale: props.locale,
    namespace: "checkout",
  });
  const errors = await destinationErrorTexts(props.issues, props.locale);
  const summary: FormErrorItem[] = DESTINATION_FIELDS.flatMap((field) => {
    const message = errors[field];
    return message ? [{ fieldId: FIELD_IDS[field], message }] : [];
  });
  return (
    <section
      aria-labelledby="destination-title"
      className="flex flex-col gap-4 border border-line p-5"
      data-testid="checkout-destination"
    >
      <h2 id="destination-title" className="text-2xl">
        {t("destination.title")}
      </h2>
      <p className="text-sm text-ink-muted">{t("destination.intro")}</p>
      <ErrorSummary errors={summary} />
      <DestinationForm {...props} />
    </section>
  );
}

/** What the buyer chose so far (step 2 and the top of step 3). */
function Recap({ children }: { children: ReactNode }) {
  return (
    <dl className="flex flex-col gap-3" data-testid="checkout-recap">
      {children}
    </dl>
  );
}

function RecapRow({
  term,
  value,
  change,
}: {
  term: string;
  value: ReactNode;
  change: { href: string; text: string; label: string; testId: string };
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-4">
      <dt className="col-start-1 row-start-1 text-sm text-ink-muted">{term}</dt>
      <dd className="col-start-1 row-start-2">{value}</dd>
      <dd className="col-start-2 row-span-2 row-start-1">
        <Link
          href={change.href}
          className={buttonClasses("ghost", "sm")}
          aria-label={change.label}
          data-testid={change.testId}
        >
          {change.text}
        </Link>
      </dd>
    </div>
  );
}

export async function DestinationRecap({
  destination: d,
  href,
  locale,
}: {
  destination: DestinationView;
  href: string;
  locale: Locale;
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  return (
    <RecapRow
      term={t("delivery.country")}
      value={
        <>
          <bdi dir="auto">{d.city}</bdi>
          {d.zip ? (
            <>
              {" "}
              <bdi dir="ltr">{d.zip}</bdi>
            </>
          ) : null}
          {", "}
          {d.countryName}
        </>
      }
      change={{
        href,
        text: t("steps.change"),
        label: t("steps.changeDestination"),
        testId: "change-destination",
      }}
    />
  );
}

export async function DeliveryRecap({
  quote,
  href,
  locale,
}: {
  quote: OkQuote;
  href: string;
  locale: Locale;
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  const [name, price] = await Promise.all([
    methodName(quote.shipping, locale),
    methodPriceLabel(quote.shipping, quote, locale),
  ]);
  return (
    <RecapRow
      term={t("delivery.methodLegend")}
      value={
        <>
          {name} · <bdi>{price}</bdi>
        </>
      }
      change={{
        href,
        text: t("steps.change"),
        label: t("steps.changeDelivery"),
        testId: "change-delivery",
      }}
    />
  );
}

/**
 * Shekels or dollars, as links rather than radios: the prices on the page are always the prices
 * that will be charged.
 */
export async function CurrencyToggle({
  current,
  hrefs,
  locale,
}: {
  current: Currency;
  hrefs: StepLinks["currency"];
  locale: Locale;
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  return (
    <div className="flex flex-col gap-2">
      <p id="currency-label" className="font-medium">
        {t("delivery.currency")}
      </p>
      <ul
        aria-labelledby="currency-label"
        className="flex flex-wrap gap-2"
        data-testid="currency-toggle"
      >
        {(["ILS", "USD"] as const).map((c) => (
          <li key={c}>
            <Link
              href={hrefs[c]}
              scroll={false}
              aria-current={current === c ? "true" : undefined}
              className={buttonClasses(
                current === c ? "secondary" : "ghost",
                "sm",
              )}
            >
              {t(c === "ILS" ? "delivery.currencyIls" : "delivery.currencyUsd")}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Step 2: the priced delivery options for the destination; the GET form asks for step 3. */
export async function DeliveryStep({
  action,
  locale,
  quote,
  ilsPerUsd,
  itemCount,
  destination,
  links,
  checked,
  problem,
}: {
  action: string;
  locale: Locale;
  quote: OkQuote;
  ilsPerUsd: number;
  itemCount: number;
  destination: DestinationView;
  links: StepLinks;
  /** The radio checked on arrival. */
  checked: string;
  problem: DeliveryProblem | null;
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  const errors: FormErrorItem[] = problem
    ? [
        {
          fieldId: `ship-${checked}`,
          message: t(
            problem === "unavailable"
              ? "delivery.unavailable"
              : "delivery.chooseMethod",
          ),
        },
      ]
    : [];
  return (
    <section
      aria-labelledby="delivery-title"
      className="flex flex-col gap-5 border border-line p-5"
      data-testid="checkout-delivery"
    >
      <h2 id="delivery-title" className="text-2xl">
        {t("delivery.stepTitle", { count: itemCount })}
      </h2>
      <Recap>
        <DestinationRecap
          destination={destination}
          href={links.destination}
          locale={locale}
        />
      </Recap>
      <ErrorSummary errors={errors} />
      <p>
        {t("delivery.worksPrice", { count: itemCount })}
        {": "}
        <Price
          amountMinor={quote.itemsTotalMinor}
          currency={quote.currency}
          locale={locale}
        />
      </p>
      {quote.usdAvailable ? (
        <CurrencyToggle
          current={quote.currency}
          hrefs={links.currency}
          locale={locale}
        />
      ) : null}
      <form
        method="get"
        action={action}
        noValidate
        className="flex flex-col gap-4"
        data-testid="delivery-form"
      >
        <input type="hidden" name="to" value={destination.country} />
        {destination.city ? (
          <input type="hidden" name="city" value={destination.city} />
        ) : null}
        {destination.zip ? (
          <input type="hidden" name="zip" value={destination.zip} />
        ) : null}
        <MethodChoices
          quote={quote}
          locale={locale}
          ilsPerUsd={ilsPerUsd}
          checked={checked}
        />
        {quote.currency === "USD" ? (
          <input type="hidden" name="cur" value="USD" />
        ) : null}
        <input type="hidden" name="step" value="details" />
        <DeliveryNotices quote={quote} locale={locale} />
        <div>
          <button
            type="submit"
            className={buttonClasses("primary")}
            data-testid="delivery-continue"
          >
            {t("steps.continue")}
          </button>
        </div>
      </form>
    </section>
  );
}

/** The top of step 3: what was chosen (with "Change" links) and the quote's notices. */
export async function DetailsIntro({
  quote,
  locale,
  destination,
  links,
}: {
  quote: OkQuote;
  locale: Locale;
  destination: DestinationView;
  links: StepLinks;
}) {
  const t = await getTranslations({ locale, namespace: "checkout" });
  return (
    <section
      aria-labelledby="details-step-title"
      className="flex flex-col gap-4 border border-line p-5"
      data-testid="checkout-details-step"
    >
      <h2 id="details-step-title" className="text-2xl">
        {t("steps.details")}
      </h2>
      <Recap>
        <DestinationRecap
          destination={destination}
          href={links.destination}
          locale={locale}
        />
        <DeliveryRecap quote={quote} href={links.delivery} locale={locale} />
      </Recap>
      <DeliveryNotices quote={quote} locale={locale} />
    </section>
  );
}
