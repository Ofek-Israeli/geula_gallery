/**
 * Catalog DTOs (spec §9.3 "Catalog DTOs", frozen at `contracts-v1`): what `server/catalog/*`
 * returns and what storefront/admin components render. Isomorphic types (UI code cannot import
 * `@/server`). Text fields are already localized for the requested locale.
 */
import type { Locale } from "./locale";
import type { Currency } from "./money";

export type SaleStatus = "AVAILABLE" | "ON_HOLD" | "SOLD" | "NOT_FOR_SALE";
export type ImageRole =
  | "MAIN"
  | "DETAIL"
  | "EDGE"
  | "BACK"
  | "FRAMED"
  | "IN_ROOM"
  | "PROCESS";
export type Orientation = "PORTRAIT" | "LANDSCAPE" | "SQUARE" | "PANORAMIC";
export type SizeBucket = "S" | "M" | "L" | "XL";

/**
 * Live commerce state of a work (spec §3.5 "Display"), computed per request from the DB
 * (`catalog/commerce-state.ts`); never cached.
 */
export type CommerceState =
  | { kind: "available"; buyable: boolean }
  /** A live checkout hold by another buyer, until `until` (ISO). JSON-LD InStock. */
  | { kind: "reserved"; until: string }
  | { kind: "on_hold"; reservedOffline: boolean }
  | { kind: "sold" }
  | { kind: "not_for_sale" };

export interface ArtworkImageDTO {
  id: string;
  role: ImageRole;
  /** `/api/files/public/<key>` (or a Blob URL). */
  src: string;
  width: number;
  height: number;
  alt: string;
  blurDataUrl: string | null;
  dominantColor: string | null;
  creditLine: string | null;
}

export interface PriceDTO {
  /** The one ILS total (VAT-inclusive when osek murshe); null when price on request. */
  ilsMinor: number | null;
  /** Shown only after a non-IL destination is chosen (spec §6.5). */
  usdMinor: number | null;
  onRequest: boolean;
}

export interface ArtworkCardDTO {
  id: string;
  slug: string;
  locale: Locale;
  title: string;
  year: number | null;
  mediumText: string;
  heightMm: number;
  widthMm: number;
  depthMm: number | null;
  orientation: Orientation;
  sizeBucket: SizeBucket;
  saleStatus: SaleStatus;
  state: CommerceState;
  price: PriceDTO;
  image: ArtworkImageDTO | null;
  isDemo: boolean;
}

export interface ArtworkDetailDTO extends ArtworkCardDTO {
  inventoryNumber: string;
  description: string;
  series: { slug: string; name: string } | null;
  images: ArtworkImageDTO[];
  framed: boolean;
  glazing: "NONE" | "GLASS" | "ACRYLIC";
  readyToHang: boolean;
  signed: boolean;
  paintedEdges: boolean;
  coaIncluded: boolean;
  shipsInternationally: boolean;
  localPickupOnly: boolean;
  quoteOnly: boolean;
  offersEnabled: boolean;
  dispatchDays: number;
  creditLine: string | null;
  /** `og_key` → absolute URL for metadata. */
  ogImage: string | null;
}

export interface CatalogPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface MoneyDTO {
  amountMinor: number;
  currency: Currency;
}

/**
 * "Delivery from" per shipping zone for the artwork page (spec §6.3 LiveBuyBox), computed by
 * `shipping/rates.ts#zoneEstimates`. `insured` is true only when that zone's quote includes
 * insurance (the UI may say "insured" only then).
 */
export type ZoneEstimateDTO =
  | {
      zone: "IL" | "EUROPE" | "NORTH_AMERICA" | "REST_OF_WORLD";
      kind: "price";
      fromIlsMinor: number;
      insured: boolean;
      estimate: string | null;
    }
  | {
      zone: "IL" | "EUROPE" | "NORTH_AMERICA" | "REST_OF_WORLD";
      kind: "quote" | "unavailable";
      estimate: string | null;
    };

/** One demo credit on `/credits` (spec §6.2): the AIC caption plus a link to the work. */
export interface CreditDTO {
  slug: string;
  title: string;
  caption: string;
}
