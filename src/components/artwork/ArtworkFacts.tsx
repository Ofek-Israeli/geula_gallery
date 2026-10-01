import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Bdi } from "@/components/ui/Bdi";
import { Dimensions } from "@/components/ui/Dimensions";
import type { ArtworkDetailDTO } from "@/lib/catalog";
import type { Locale } from "@/lib/locale";

type PackagingType =
  | "ROLLED_TUBE"
  | "FLAT_BOX"
  | "STRETCHED_BOX"
  | "FRAMED_BOX"
  | "CRATE";

/** Medium, dimensions in cm and inches (in `<bdi dir="ltr">`), frame, COA, packaging, dispatch. */
export function ArtworkFacts({
  artwork,
  packagingType,
}: {
  artwork: ArtworkDetailDTO;
  packagingType: PackagingType;
}) {
  const t = useTranslations("artwork.facts");
  const locale = useLocale() as Locale;
  const rows: [string, ReactNode][] = [
    [t("medium"), artwork.mediumText],
    [
      t("dimensions"),
      <Dimensions
        key="d"
        locale={locale}
        heightMm={artwork.heightMm}
        widthMm={artwork.widthMm}
        depthMm={artwork.depthMm}
      />,
    ],
  ];
  if (artwork.year) rows.push([t("year"), String(artwork.year)]);
  if (artwork.series) rows.push([t("series"), artwork.series.name]);
  rows.push([t("frame"), artwork.framed ? t("framed") : t("unframed")]);
  rows.push([t("readyToHang"), artwork.readyToHang ? t("yes") : t("no")]);
  if (artwork.coaIncluded) rows.push([t("coa"), t("coaIncluded")]);
  rows.push([t("packaging"), t(`packagingType.${packagingType}`)]);
  rows.push([
    t("dispatchLabel"),
    t("dispatch", { days: artwork.dispatchDays }),
  ]);
  rows.push([t("inventory"), <Bdi key="i">{artwork.inventoryNumber}</Bdi>]);

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-muted">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
