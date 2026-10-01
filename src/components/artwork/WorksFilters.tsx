"use client";

import { useTranslations } from "next-intl";
import type { FormEvent } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Link, useRouter } from "@/i18n/navigation";
import {
  DEFAULT_WORKS_PARAMS,
  ORIENTATION_VALUES,
  PRICE_BANDS,
  parseWorksParams,
  SIZE_VALUES,
  SORT_VALUES,
  type WorksParams,
  worksHref,
} from "./works-params";

/**
 * Filters and sort for `/works` (spec §6.2), synced to the URL. A plain GET form, so it works
 * before hydration; once hydrated, "Apply" navigates to the canonical URL (defaults omitted)
 * instead of a query with empty values. Nothing changes until the buyer presses "Apply"
 * (WCAG 3.2.2: no change of context on input).
 */
export function WorksFilters({
  action,
  params,
  series,
}: {
  /** The localized `/works` path (the no-JS form target). */
  action: string;
  params: WorksParams;
  series: { slug: string; name: string }[];
}) {
  const t = useTranslations("catalog.filters");
  const router = useRouter();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const raw: Record<string, string> = {};
    for (const [k, v] of data) if (typeof v === "string") raw[k] = v;
    router.push(worksHref({ ...parseWorksParams(raw), page: 1 }));
  }

  const fields: {
    name: keyof WorksParams;
    label: string;
    value: string;
    placeholder?: string;
    options: { value: string; label: string }[];
  }[] = [
    {
      name: "availability",
      label: t("availability"),
      value: params.availability ?? "",
      options: [
        { value: "", label: t("availabilityCurrent") },
        { value: "available", label: t("availabilityAvailable") },
        { value: "sold", label: t("availabilitySold") },
      ],
    },
    {
      name: "series",
      label: t("series"),
      value: params.series ?? "",
      placeholder: t("any"),
      options: series.map((s) => ({ value: s.slug, label: s.name })),
    },
    {
      name: "size",
      label: t("size"),
      value: params.size?.toLowerCase() ?? "",
      placeholder: t("any"),
      options: SIZE_VALUES.map((v) => ({
        value: v.toLowerCase(),
        label: t(`sizes.${v}`),
      })),
    },
    {
      name: "orientation",
      label: t("orientation"),
      value: params.orientation?.toLowerCase() ?? "",
      placeholder: t("any"),
      options: ORIENTATION_VALUES.map((v) => ({
        value: v.toLowerCase(),
        label: t(`orientations.${v}`),
      })),
    },
    {
      name: "price",
      label: t("price"),
      value: params.price ?? "",
      placeholder: t("any"),
      options: PRICE_BANDS.map((b) => ({
        value: b.id,
        label: t(`prices.${b.id}`),
      })),
    },
    {
      name: "sort",
      label: t("sort"),
      value: params.sort,
      options: SORT_VALUES.map((v) => ({ value: v, label: t(`sorts.${v}`) })),
    },
  ];

  return (
    <form
      method="get"
      action={action}
      onSubmit={onSubmit}
      aria-label={t("label")}
      className="flex flex-wrap items-end gap-x-4 gap-y-3 border-y border-line py-4"
      data-testid="works-filters"
    >
      {fields.map((f) => {
        const id = `works-${f.name}`;
        return (
          <div key={f.name} className="flex min-w-36 flex-1 flex-col gap-1">
            <label htmlFor={id} className="text-sm font-medium">
              {f.label}
            </label>
            <Select
              id={id}
              name={f.name}
              defaultValue={f.value}
              placeholder={f.placeholder}
              options={f.options}
            />
          </div>
        );
      })}
      <div className="flex items-center gap-4">
        <button type="submit" className={buttonClasses("primary")}>
          {t("apply")}
        </button>
        <Link
          href={worksHref(DEFAULT_WORKS_PARAMS)}
          className="inline-flex min-h-11 items-center"
        >
          {t("clear")}
        </Link>
      </div>
    </form>
  );
}
