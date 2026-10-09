"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import {
  cancellationBase,
  cancellationRefund,
} from "@/lib/cancellation-amounts";
import { changeOfMindFee } from "@/lib/deadlines";
import type { Locale } from "@/lib/locale";
import { formatMoney, fromDecimal, toDecimalString } from "@/lib/money";
import type { AcceptPreview } from "@/server/cancellations/service";
import { AdminActionForm } from "./AdminActionForm";
import { acceptAction } from "./actions";

/**
 * The accept decision (spec §5.7 step 7) with the works to cancel. Each active work of the order is
 * a checkbox (the buyer's choice pre-ticked); the amounts — works, shipping (refunded only when no
 * work is left), the suggested fee (the ₪100 cap shared by the order) and the refund — are
 * recomputed live with the same pure helpers the server uses. Without JavaScript the form still
 * posts the ticked works and the server computes the same amounts.
 */
export function AcceptCancellationForm({
  locale,
  cancellationId,
  items,
  preview,
  eligible,
}: {
  locale: Locale;
  cancellationId: string;
  items: { id: string; title: string; priceMinor: number; checked: boolean }[];
  preview: AcceptPreview;
  eligible: boolean;
}) {
  const t = useTranslations("cancel.admin");
  const [chosen, setChosen] = useState(
    () => new Set(items.filter((i) => i.checked).map((i) => i.id)),
  );
  const amounts = (ids: ReadonlySet<string>) => {
    const selected = items.filter((i) => ids.has(i.id));
    const base = cancellationBase({
      cancelledItemsMinor: selected.reduce((s, i) => s + i.priceMinor, 0),
      orderItemsMinor: preview.orderItemsMinor,
      paidMinor: preview.paidMinor,
      final:
        selected.length > 0 && selected.length === preview.activeItemIds.length,
    });
    let feeMinor = 0;
    try {
      feeMinor = changeOfMindFee({
        regime: preview.fee.regime,
        reason: preview.fee.reason,
        totalPaidMinor: base.baseMinor,
        currency: preview.currency,
        ...(preview.fee.ilsPerUsd ? { ilsPerUsd: preview.fee.ilsPerUsd } : {}),
        policy: preview.fee.policy,
        alreadyWithheldMinor: preview.fee.alreadyWithheldMinor,
      }).feeMinor;
    } catch {
      feeMinor = 0;
    }
    return { ...base, feeMinor, count: selected.length };
  };
  const current = amounts(chosen);
  const [feeText, setFeeText] = useState(() =>
    toDecimalString(current.feeMinor),
  );
  const [feeEdited, setFeeEdited] = useState(false);

  let typedFee = current.feeMinor;
  try {
    const v = fromDecimal(feeText.trim() === "" ? "0" : feeText.trim());
    typedFee = Math.max(0, Math.min(v, current.feeMinor));
  } catch {
    typedFee = current.feeMinor;
  }
  const refundMinor = cancellationRefund(
    {
      baseMinor: current.baseMinor,
      paidMinor: preview.paidMinor,
      alreadyRefundedMinor: preview.alreadyRefundedMinor,
    },
    feeText.trim() === "" ? current.feeMinor : typedFee,
  );
  const money = (minor: number) => formatMoney(minor, preview.currency, locale);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
    // A fee the admin did not type follows the suggestion for the new choice.
    if (!feeEdited) setFeeText(toDecimalString(amounts(next).feeMinor));
  };

  const choosing = items.length > 1;
  return (
    <AdminActionForm
      action={acceptAction}
      locale={locale}
      cancellationId={cancellationId}
      submitLabel={t("accept")}
      variant="primary"
      confirm={t("acceptConfirmItems", { count: current.count })}
      testId="accept-cancellation"
    >
      {choosing ? (
        <fieldset className="flex flex-col gap-2" data-testid="accept-items">
          <legend className="mbe-2 font-semibold">{t("worksToCancel")}</legend>
          <input type="hidden" name="itemsShown" value="on" />
          {items.map((i) => (
            <Checkbox
              key={i.id}
              id={`a-item-${i.id}`}
              name="orderItemId"
              value={i.id}
              checked={chosen.has(i.id)}
              onChange={(e) => toggle(i.id, e.currentTarget.checked)}
              label={`${i.title} · ${money(i.priceMinor)}`}
            />
          ))}
        </fieldset>
      ) : null}
      <dl
        className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1"
        data-testid="accept-preview"
        aria-live="polite"
      >
        <dt className="text-ink-muted">{t("previewWorks")}</dt>
        <dd data-testid="preview-items">{money(current.itemsMinor)}</dd>
        <dt className="text-ink-muted">{t("previewShipping")}</dt>
        <dd data-testid="preview-shipping">
          {current.count > 0 && current.count === preview.activeItemIds.length
            ? money(current.shippingRefundMinor)
            : t("previewShippingKept")}
        </dd>
        <dt className="text-ink-muted">{t("fee")}</dt>
        <dd data-testid="suggested-fee">{money(current.feeMinor)}</dd>
        <dt className="text-ink-muted">{t("refundAmount")}</dt>
        <dd className="font-semibold" data-testid="preview-refund">
          {money(refundMinor)}
        </dd>
      </dl>
      <Field id="a-fee" label={t("feeInput")} hint={t("feeHint")}>
        {(f) => (
          <Input
            {...f}
            name="feeMinor"
            dir="ltr"
            inputMode="decimal"
            value={feeText}
            onChange={(e) => {
              setFeeText(e.currentTarget.value);
              setFeeEdited(true);
            }}
          />
        )}
      </Field>
      {eligible ? (
        <Checkbox
          id="a-grant"
          name="grantFourMonths"
          label={t("grant4m")}
          defaultChecked
        />
      ) : null}
      <Field id="a-note" label={t("note")}>
        {(f) => <Input {...f} name="note" />}
      </Field>
    </AdminActionForm>
  );
}
