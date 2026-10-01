import { useTranslations } from "next-intl";
import {
  type DimensionsLocale,
  type DimensionsMm,
  formatDimensions,
} from "@/lib/dimensions";
import { Bdi } from "./Bdi";

/** `H × W [× D] cm (h × w [× d] in)`, in `<bdi dir="ltr">` (spec §6.3). */
export function Dimensions({
  locale,
  className,
  ...mm
}: DimensionsMm & { locale: DimensionsLocale; className?: string }) {
  const t = useTranslations("common.units");
  const { cm, inches } = formatDimensions(mm, locale);
  return (
    <span className={className}>
      <Bdi>
        {cm} {t("cm")}
      </Bdi>{" "}
      <span className="text-ink-muted">
        (
        <Bdi>
          {inches} {t("in")}
        </Bdi>
        )
      </span>
    </span>
  );
}
