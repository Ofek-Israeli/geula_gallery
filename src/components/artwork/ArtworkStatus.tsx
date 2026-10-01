import { useLocale, useTranslations } from "next-intl";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Price } from "@/components/ui/Price";
import type { CommerceState, PriceDTO } from "@/lib/catalog";
import { formatTime } from "@/lib/format";
import type { Locale } from "@/lib/locale";

/** Status always as text (spec §3.5 "Display", §6.7); the red dot on "Sold" is decoration. */
export function useStatusText(): (state: CommerceState) => string {
  const t = useTranslations("artwork.status");
  const locale = useLocale() as Locale;
  return (state) => {
    switch (state.kind) {
      case "available":
        return t("available");
      case "reserved":
        return t("reserved", { time: formatTime(state.until, locale) });
      case "on_hold":
        return state.reservedOffline ? t("reservedOffline") : t("onHold");
      case "sold":
        return t("sold");
      case "not_for_sale":
        return t("notForSale");
    }
  };
}

export function statusTone(state: CommerceState): BadgeTone {
  switch (state.kind) {
    case "available":
      return "available";
    case "reserved":
    case "on_hold":
      return "hold";
    case "sold":
      return "sold";
    case "not_for_sale":
      return "neutral";
  }
}

/** The card's status line: the ILS price for available works, otherwise the status badge. */
export function ArtworkStatus({
  state,
  price,
}: {
  state: CommerceState;
  price: PriceDTO;
}) {
  const statusText = useStatusText();
  const t = useTranslations("artwork.buy");
  const locale = useLocale() as Locale;
  if (state.kind === "available") {
    if (price.onRequest || price.ilsMinor === null) {
      return <span className="text-ink-muted">{t("priceOnRequest")}</span>;
    }
    return (
      <Price amountMinor={price.ilsMinor} currency="ILS" locale={locale} />
    );
  }
  return <Badge tone={statusTone(state)}>{statusText(state)}</Badge>;
}
