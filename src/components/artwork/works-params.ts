/**
 * `/works` URL state (spec §6.2): GET parameters for the filters and the sort, parsed leniently
 * (unknown values are ignored) and serialized canonically (defaults omitted, fixed key order), so
 * every filter combination has one URL and the language switch keeps it.
 *
 * | Param          | Values                                                        |
 * |----------------|---------------------------------------------------------------|
 * | `availability` | `available` · `sold` (archive); absent = available + on hold + not for sale |
 * | `series`       | a series slug                                                 |
 * | `size`         | `s` · `m` · `l` · `xl`                                        |
 * | `orientation`  | `portrait` · `landscape` · `square` · `panoramic`             |
 * | `price`        | a band id from `PRICE_BANDS`                                  |
 * | `sort`         | `featured` (default) · `newest` · `price-asc` · `price-desc` · `size-asc` · `size-desc` |
 * | `page`         | ≥ 2                                                           |
 */
import type { Orientation, SizeBucket } from "@/lib/catalog";
import { paths } from "@/lib/routes";

export const AVAILABILITY_VALUES = ["available", "sold"] as const;
export type Availability = (typeof AVAILABILITY_VALUES)[number];

export const SIZE_VALUES = [
  "S",
  "M",
  "L",
  "XL",
] as const satisfies readonly SizeBucket[];
export const ORIENTATION_VALUES = [
  "PORTRAIT",
  "LANDSCAPE",
  "SQUARE",
  "PANORAMIC",
] as const satisfies readonly Orientation[];

export const SORT_VALUES = [
  "featured",
  "newest",
  "price-asc",
  "price-desc",
  "size-asc",
  "size-desc",
] as const;
export type WorksSortParam = (typeof SORT_VALUES)[number];

/** Price bands in ILS (whole shekels); `[min, max)`, `max` null = open. */
export const PRICE_BANDS = [
  { id: "under-5000", minIls: null, maxIls: 5_000 },
  { id: "5000-10000", minIls: 5_000, maxIls: 10_000 },
  { id: "10000-20000", minIls: 10_000, maxIls: 20_000 },
  { id: "over-20000", minIls: 20_000, maxIls: null },
] as const satisfies readonly {
  id: string;
  minIls: number | null;
  maxIls: number | null;
}[];
export type PriceBandId = (typeof PRICE_BANDS)[number]["id"];

export interface WorksParams {
  availability: Availability | null;
  series: string | null;
  size: SizeBucket | null;
  orientation: Orientation | null;
  price: PriceBandId | null;
  sort: WorksSortParam;
  page: number;
}

export const DEFAULT_WORKS_PARAMS: WorksParams = {
  availability: null,
  series: null,
  size: null,
  orientation: null,
  price: null,
  sort: "featured",
  page: 1,
};

type RawQuery = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

function oneOf<T extends string>(
  values: readonly T[],
  raw: string | undefined,
): T | null {
  return raw !== undefined && (values as readonly string[]).includes(raw)
    ? (raw as T)
    : null;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Parses `searchParams`; invalid values fall back to the defaults (never throws). */
export function parseWorksParams(query: RawQuery): WorksParams {
  const page = Number.parseInt(first(query.page) ?? "1", 10);
  const series = first(query.series);
  return {
    availability: oneOf(AVAILABILITY_VALUES, first(query.availability)),
    series: series && SLUG.test(series) ? series : null,
    size: oneOf(SIZE_VALUES, first(query.size)?.toUpperCase()),
    orientation: oneOf(
      ORIENTATION_VALUES,
      first(query.orientation)?.toUpperCase(),
    ),
    price: oneOf(
      PRICE_BANDS.map((b) => b.id),
      first(query.price),
    ),
    sort: oneOf(SORT_VALUES, first(query.sort)) ?? "featured",
    page: Number.isFinite(page) && page > 1 ? Math.min(page, 10_000) : 1,
  };
}

/** Canonical query object (defaults omitted, lower-case enum values). */
export function worksQuery(
  p: WorksParams,
): Record<string, string | number | undefined> {
  return {
    availability: p.availability ?? undefined,
    series: p.series ?? undefined,
    size: p.size?.toLowerCase(),
    orientation: p.orientation?.toLowerCase(),
    price: p.price ?? undefined,
    sort: p.sort === "featured" ? undefined : p.sort,
    page: p.page > 1 ? p.page : undefined,
  };
}

/** Locale-less `/works?...` for `<Link>`; a patch that changes a filter resets the page. */
export function worksHref(
  p: WorksParams,
  patch: Partial<WorksParams> = {},
): string {
  const resetsPage = Object.keys(patch).some((k) => k !== "page");
  const next: WorksParams = {
    ...p,
    ...(resetsPage ? { page: 1 } : {}),
    ...patch,
  };
  return paths.works(worksQuery(next));
}

/** True when any filter (not the sort or page) narrows the view. */
export function hasFilters(p: WorksParams): boolean {
  return (
    p.series !== null ||
    p.size !== null ||
    p.orientation !== null ||
    p.price !== null ||
    p.availability === "available"
  );
}

/** The band's bounds in ILS minor units for the catalog query. */
export function priceBounds(id: PriceBandId | null): {
  priceMinIlsMinor: number | null;
  priceMaxIlsMinor: number | null;
} {
  const band = PRICE_BANDS.find((b) => b.id === id);
  return {
    priceMinIlsMinor: band?.minIls != null ? band.minIls * 100 : null,
    priceMaxIlsMinor: band?.maxIls != null ? band.maxIls * 100 : null,
  };
}
