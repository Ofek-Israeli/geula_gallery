/**
 * JSON-LD builders (spec §6.3, §6.6): pure functions over catalog DTOs and plain data, so they are
 * unit-tested without a server. Pages pass the absolute site origin (`APP_URL`).
 *
 * - Artwork: `["VisualArtwork", "Product"]` with creator, dateCreated, artform, artMedium,
 *   artworkSurface, `QuantitativeValue` sizes in CMT, sku, NewCondition and an Offer whose ILS
 *   price is the visible one. No Offer for not-for-sale works, price on request, or a demo work
 *   on a live store (spec §6.3).
 * - BreadcrumbList, Organization (`hasMerchantReturnPolicy`, `hasShippingService`), Person.
 */
import type { ArtworkDetailDTO, CommerceState } from "@/lib/catalog";
import type { Locale } from "@/lib/locale";
import { localePath, paths } from "@/lib/routes";

export type JsonLdObject = { [key: string]: unknown };

const SCHEMA = "https://schema.org";

export function absolute(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

/** JSON for a `<script type="application/ld+json">`; `<`, `>`, `&` and U+2028/9 are escaped. */
export function serializeJsonLd(data: JsonLdObject | JsonLdObject[]): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function breadcrumbJsonLd(
  base: string,
  items: { name: string; path: string }[],
): JsonLdObject {
  return {
    "@context": SCHEMA,
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: absolute(base, item.path),
    })),
  };
}

/** schema.org ItemAvailability for a live commerce state (spec §3.5 "Display"). */
export function availabilityOf(state: CommerceState): string | null {
  switch (state.kind) {
    case "available":
    case "reserved":
      // A live checkout hold by another buyer is still InStock (spec §3.5).
      return `${SCHEMA}/InStock`;
    case "on_hold":
      return `${SCHEMA}/Reserved`;
    case "sold":
      return `${SCHEMA}/SoldOut`;
    case "not_for_sale":
      return null;
  }
}

/** True when the ILS price is shown on the page: an available or checkout-held, priced work. */
export function priceIsVisible(
  a: Pick<ArtworkDetailDTO, "state" | "price">,
): boolean {
  return (
    (a.state.kind === "available" || a.state.kind === "reserved") &&
    !a.price.onRequest &&
    a.price.ilsMinor !== null
  );
}

const SURFACE_EN: Record<string, string> = {
  CANVAS: "Canvas",
  LINEN: "Linen",
  WOOD_PANEL: "Wood panel",
  BOARD: "Board",
  CARDBOARD: "Cardboard",
  PAPER: "Paper",
};

const MEDIUM_EN: Record<string, string> = {
  OIL: "Oil paint",
  ACRYLIC: "Acrylic paint",
  WATERCOLOR: "Watercolor",
  GOUACHE: "Gouache",
  INK: "Ink",
  CHARCOAL: "Charcoal",
  PASTEL: "Pastel",
  TEMPERA: "Tempera",
  MIXED_MEDIA: "Mixed media",
};

export interface ArtworkJsonLdInput {
  base: string;
  locale: Locale;
  artwork: ArtworkDetailDTO;
  medium: string;
  surface: string;
  /** The painter's name for `creator`. */
  artistName: string;
  /** Absolute or site-relative image URLs, main image first. */
  images: string[];
  /** The store takes live payments (`DEMO_MODE=false`): demo works then get no Offer. */
  liveStore: boolean;
  /** The seller (`Organization`) `@id`. */
  sellerId?: string;
}

function cm(mm: number) {
  return {
    "@type": "QuantitativeValue",
    value: Math.round(mm) / 10,
    unitCode: "CMT",
  };
}

/** `["VisualArtwork","Product"]` for `/works/[slug]` (spec §6.6). */
export function artworkJsonLd(i: ArtworkJsonLdInput): JsonLdObject {
  const a = i.artwork;
  const url = absolute(i.base, localePath(i.locale, paths.artwork(a.slug)));
  const availability = availabilityOf(a.state);
  const offerAllowed =
    availability !== null && !a.price.onRequest && !(a.isDemo && i.liveStore);
  const out: JsonLdObject = {
    "@context": SCHEMA,
    "@type": ["VisualArtwork", "Product"],
    "@id": `${url}#artwork`,
    url,
    name: a.title,
    inLanguage: i.locale,
    sku: a.inventoryNumber,
    itemCondition: `${SCHEMA}/NewCondition`,
    artform: i.locale === "he" ? "ציור" : "Painting",
    artMedium: a.mediumText || MEDIUM_EN[i.medium] || undefined,
    artworkSurface: SURFACE_EN[i.surface],
    creator: { "@type": "Person", name: i.artistName },
    height: cm(a.heightMm),
    width: cm(a.widthMm),
    ...(a.depthMm !== null ? { depth: cm(a.depthMm) } : {}),
    ...(a.year !== null ? { dateCreated: String(a.year) } : {}),
    ...(a.description ? { description: a.description } : {}),
    ...(i.images.length > 0
      ? { image: i.images.map((src) => absolute(i.base, src)) }
      : {}),
  };
  if (offerAllowed) {
    out.offers = {
      "@type": "Offer",
      url,
      availability,
      itemCondition: `${SCHEMA}/NewCondition`,
      // The one ILS price per catalog URL (spec §6.5), only when it is shown on the page.
      ...(priceIsVisible(a) && a.price.ilsMinor !== null
        ? {
            price: (a.price.ilsMinor / 100).toFixed(2),
            priceCurrency: "ILS",
          }
        : {}),
      ...(i.sellerId ? { seller: { "@id": i.sellerId } } : {}),
    };
  }
  // Drop undefined values (JSON.stringify would anyway; keeps tests exact).
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export interface OrganizationJsonLdInput {
  base: string;
  locale: Locale;
  name: string;
  email: string;
  telephone: string;
}

export function organizationId(base: string): string {
  return absolute(base, "/#organization");
}

export function personId(base: string): string {
  return absolute(base, "/#artist");
}

/** The gallery as a seller, with its 14-day return policy and shipping service (spec §6.2). */
export function organizationJsonLd(i: OrganizationJsonLdInput): JsonLdObject {
  const home = absolute(i.base, localePath(i.locale, paths.home()));
  return {
    "@context": SCHEMA,
    "@type": "Organization",
    "@id": organizationId(i.base),
    name: i.name,
    url: home,
    email: i.email,
    telephone: i.telephone,
    address: { "@type": "PostalAddress", addressCountry: "IL" },
    hasMerchantReturnPolicy: {
      "@type": "MerchantReturnPolicy",
      applicableCountry: "IL",
      returnPolicyCountry: "IL",
      returnPolicyCategory: `${SCHEMA}/MerchantReturnFiniteReturnWindow`,
      merchantReturnDays: 14,
      returnMethod: `${SCHEMA}/ReturnByMail`,
      merchantReturnLink: absolute(
        i.base,
        localePath(i.locale, paths.legal("returns")),
      ),
    },
    hasShippingService: {
      "@type": "ShippingService",
      url: absolute(i.base, localePath(i.locale, paths.legal("shipping"))),
      shippingConditions: {
        "@type": "ShippingConditions",
        shippingDestination: {
          "@type": "DefinedRegion",
          addressCountry: "IL",
        },
      },
    },
  };
}

export interface PersonJsonLdInput {
  base: string;
  locale: Locale;
  name: string;
  jobTitle: string;
  email?: string;
}

/** The painter (about and contact pages, spec §6.2). */
export function personJsonLd(i: PersonJsonLdInput): JsonLdObject {
  return {
    "@context": SCHEMA,
    "@type": "Person",
    "@id": personId(i.base),
    name: i.name,
    jobTitle: i.jobTitle,
    url: absolute(i.base, localePath(i.locale, paths.about())),
    ...(i.email ? { email: i.email } : {}),
    worksFor: { "@id": organizationId(i.base) },
  };
}
