import { describe, expect, it } from "vitest";
import {
  primaryAction,
  shownPriceMinor,
  trustItems,
  zoneIsInsured,
} from "@/components/artwork/buy-box";
import {
  DEFAULT_WORKS_PARAMS,
  hasFilters,
  parseWorksParams,
  priceBounds,
  worksHref,
} from "@/components/artwork/works-params";
import { phoneDigits } from "@/components/site/ContactDetails";
import { metaDescription, pageMetadata } from "@/components/site/metadata";
import {
  artworkJsonLd,
  availabilityOf,
  breadcrumbJsonLd,
  organizationJsonLd,
  personJsonLd,
  serializeJsonLd,
} from "@/components/site/structured-data";
import type {
  ArtworkDetailDTO,
  CommerceState,
  ZoneEstimateDTO,
} from "@/lib/catalog";

/** WS1 storefront pure logic: URL state, buy-box decisions, JSON-LD and metadata (spec §6.2–6.6). */

function artwork(over: Partial<ArtworkDetailDTO> = {}): ArtworkDetailDTO {
  return {
    id: "a1",
    slug: "landscape-no-26",
    locale: "en",
    title: "Landscape no. 26",
    year: 1909,
    mediumText: "Oil on cardboard",
    heightMm: 305,
    widthMm: 305,
    depthMm: 10,
    orientation: "SQUARE",
    sizeBucket: "S",
    saleStatus: "AVAILABLE",
    state: { kind: "available", buyable: true },
    price: { ilsMinor: 320_000, usdMinor: 87_000, onRequest: false },
    image: null,
    isDemo: true,
    inventoryNumber: "A-2026-001",
    description: "A hilly landscape.",
    series: null,
    images: [],
    framed: false,
    glazing: "NONE",
    readyToHang: false,
    signed: false,
    paintedEdges: false,
    coaIncluded: true,
    shipsInternationally: true,
    localPickupOnly: false,
    quoteOnly: false,
    offersEnabled: false,
    dispatchDays: 5,
    creditLine: null,
    ogImage: null,
    ...over,
  };
}

describe("works URL params", () => {
  it("parses valid values and ignores invalid ones", () => {
    expect(
      parseWorksParams({
        availability: "sold",
        series: "landscapes",
        size: "m",
        orientation: "Landscape",
        price: "5000-10000",
        sort: "price-desc",
        page: "3",
      }),
    ).toEqual({
      availability: "sold",
      series: "landscapes",
      size: "M",
      orientation: "LANDSCAPE",
      price: "5000-10000",
      sort: "price-desc",
      page: 3,
    });
    expect(
      parseWorksParams({
        availability: "all",
        series: "../x",
        size: "huge",
        orientation: "",
        price: "cheap",
        sort: "random",
        page: "-2",
      }),
    ).toEqual(DEFAULT_WORKS_PARAMS);
    // Repeated keys: the first wins.
    expect(parseWorksParams({ size: ["l", "s"] }).size).toBe("L");
  });

  it("serializes canonically, omitting defaults, and resets the page on filter changes", () => {
    expect(worksHref(DEFAULT_WORKS_PARAMS)).toBe("/works");
    const p = parseWorksParams({ size: "m", sort: "newest", page: "2" });
    expect(worksHref(p)).toBe("/works?size=m&sort=newest&page=2");
    expect(worksHref(p, { page: 3 })).toBe("/works?size=m&sort=newest&page=3");
    expect(worksHref(p, { orientation: "PORTRAIT" })).toBe(
      "/works?size=m&orientation=portrait&sort=newest",
    );
    expect(worksHref(p, { sort: "featured" })).toBe("/works?size=m");
  });

  it("knows when filters narrow the view and maps price bands to minor units", () => {
    expect(hasFilters(DEFAULT_WORKS_PARAMS)).toBe(false);
    expect(hasFilters({ ...DEFAULT_WORKS_PARAMS, sort: "newest" })).toBe(false);
    expect(hasFilters({ ...DEFAULT_WORKS_PARAMS, availability: "sold" })).toBe(
      false,
    );
    expect(
      hasFilters({ ...DEFAULT_WORKS_PARAMS, availability: "available" }),
    ).toBe(true);
    expect(hasFilters({ ...DEFAULT_WORKS_PARAMS, price: "over-20000" })).toBe(
      true,
    );
    expect(priceBounds("under-5000")).toEqual({
      priceMinIlsMinor: null,
      priceMaxIlsMinor: 500_000,
    });
    expect(priceBounds("10000-20000")).toEqual({
      priceMinIlsMinor: 1_000_000,
      priceMaxIlsMinor: 2_000_000,
    });
    expect(priceBounds(null)).toEqual({
      priceMinIlsMinor: null,
      priceMaxIlsMinor: null,
    });
  });
});

describe("buy box decisions", () => {
  const il = (insured: boolean): ZoneEstimateDTO => ({
    zone: "IL",
    kind: "price",
    fromIlsMinor: 6_000,
    insured,
    estimate: null,
  });
  const na: ZoneEstimateDTO = {
    zone: "NORTH_AMERICA",
    kind: "price",
    fromIlsMinor: 40_200,
    insured: true,
    estimate: null,
  };

  it('says "insured" in the trust row only when the Israeli quote includes it', () => {
    expect(trustItems([il(false), na], true)).toEqual([
      "tracked",
      "cancellation",
      "coa",
    ]);
    expect(trustItems([il(true), na], false)).toEqual([
      "tracked",
      "insured",
      "cancellation",
    ]);
    expect(
      trustItems([{ zone: "IL", kind: "quote", estimate: null }], true),
    ).not.toContain("insured");
    expect(trustItems([], true)).not.toContain("insured");
  });

  it("marks only insured zone prices", () => {
    expect(zoneIsInsured(na)).toBe(true);
    expect(zoneIsInsured(il(false))).toBe(false);
    expect(
      zoneIsInsured({ zone: "EUROPE", kind: "quote", estimate: null }),
    ).toBe(false);
  });

  it("shows the price for available and checkout-held works only", () => {
    expect(shownPriceMinor(artwork())).toBe(320_000);
    expect(
      shownPriceMinor(
        artwork({ state: { kind: "reserved", until: "2026-10-01T10:00:00Z" } }),
      ),
    ).toBe(320_000);
    expect(shownPriceMinor(artwork({ state: { kind: "sold" } }))).toBeNull();
    expect(
      shownPriceMinor(
        artwork({ state: { kind: "on_hold", reservedOffline: true } }),
      ),
    ).toBeNull();
    expect(
      shownPriceMinor(
        artwork({ price: { ilsMinor: null, usdMinor: null, onRequest: true } }),
      ),
    ).toBeNull();
  });

  it("picks the main call to action", () => {
    expect(primaryAction(artwork())).toEqual({ kind: "buy" });
    expect(
      primaryAction(
        artwork({
          quoteOnly: true,
          state: { kind: "available", buyable: false },
        }),
      ),
    ).toMatchObject({ request: "quote", label: "requestQuote" });
    expect(primaryAction(artwork({ state: { kind: "sold" } }))).toMatchObject({
      request: "question",
      label: "askSimilar",
    });
    expect(
      primaryAction(artwork({ state: { kind: "not_for_sale" } })),
    ).toMatchObject({ request: "question", label: "ask" });
  });
});

describe("JSON-LD", () => {
  const base = "https://gallery.example";
  const input = {
    base,
    locale: "en" as const,
    medium: "OIL",
    surface: "CARDBOARD",
    artistName: "The Painter",
    images: ["/api/files/public/a.jpg"],
    liveStore: false,
    sellerId: `${base}/#organization`,
  };

  it("describes a work as VisualArtwork + Product with the visible ILS price", () => {
    const ld = artworkJsonLd({ ...input, artwork: artwork() });
    expect(ld).toMatchObject({
      "@type": ["VisualArtwork", "Product"],
      name: "Landscape no. 26",
      url: `${base}/en/works/landscape-no-26`,
      sku: "A-2026-001",
      itemCondition: "https://schema.org/NewCondition",
      artMedium: "Oil on cardboard",
      artworkSurface: "Cardboard",
      dateCreated: "1909",
      creator: { "@type": "Person", name: "The Painter" },
      height: { value: 30.5, unitCode: "CMT" },
      width: { value: 30.5, unitCode: "CMT" },
      depth: { value: 1, unitCode: "CMT" },
      image: [`${base}/api/files/public/a.jpg`],
      offers: {
        "@type": "Offer",
        availability: "https://schema.org/InStock",
        price: "3200.00",
        priceCurrency: "ILS",
        seller: { "@id": `${base}/#organization` },
      },
    });
  });

  it("maps every state and omits the Offer when the spec says so", () => {
    const states: [CommerceState, string | null][] = [
      [{ kind: "available", buyable: true }, "https://schema.org/InStock"],
      [{ kind: "reserved", until: "x" }, "https://schema.org/InStock"],
      [
        { kind: "on_hold", reservedOffline: false },
        "https://schema.org/Reserved",
      ],
      [{ kind: "sold" }, "https://schema.org/SoldOut"],
      [{ kind: "not_for_sale" }, null],
    ];
    for (const [state, availability] of states) {
      expect(availabilityOf(state)).toBe(availability);
    }
    const sold = artworkJsonLd({
      ...input,
      artwork: artwork({ state: { kind: "sold" } }),
    });
    expect(sold.offers).toEqual({
      "@type": "Offer",
      url: `${base}/en/works/landscape-no-26`,
      availability: "https://schema.org/SoldOut",
      itemCondition: "https://schema.org/NewCondition",
      seller: { "@id": `${base}/#organization` },
    });
    expect(
      artworkJsonLd({
        ...input,
        artwork: artwork({ state: { kind: "not_for_sale" } }),
      }).offers,
    ).toBeUndefined();
    expect(
      artworkJsonLd({
        ...input,
        artwork: artwork({
          price: { ilsMinor: null, usdMinor: null, onRequest: true },
        }),
      }).offers,
    ).toBeUndefined();
    // A demo work on a live store: no Offer.
    expect(
      artworkJsonLd({ ...input, liveStore: true, artwork: artwork() }).offers,
    ).toBeUndefined();
    expect(
      artworkJsonLd({
        ...input,
        liveStore: true,
        artwork: artwork({ isDemo: false }),
      }).offers,
    ).toBeDefined();
  });

  it("builds breadcrumbs, organization and person blocks", () => {
    expect(
      breadcrumbJsonLd(base, [
        { name: "Home", path: "/en" },
        { name: "Works", path: "/en/works" },
      ]),
    ).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { position: 1, name: "Home", item: `${base}/en` },
        { position: 2, name: "Works", item: `${base}/en/works` },
      ],
    });
    expect(
      organizationJsonLd({
        base,
        locale: "he",
        name: "Gallery",
        email: "studio@example.com",
        telephone: "+972-3-000-0000",
      }),
    ).toMatchObject({
      "@type": "Organization",
      url: `${base}/he`,
      hasMerchantReturnPolicy: {
        merchantReturnDays: 14,
        applicableCountry: "IL",
        merchantReturnLink: `${base}/he/legal/returns`,
      },
      hasShippingService: {
        "@type": "ShippingService",
        url: `${base}/he/legal/shipping`,
      },
    });
    expect(
      personJsonLd({ base, locale: "en", name: "P", jobTitle: "Painter" }),
    ).toMatchObject({
      "@type": "Person",
      url: `${base}/en/about`,
      worksFor: { "@id": `${base}/#organization` },
    });
  });

  it("escapes text that could close the script element", () => {
    const out = serializeJsonLd({ name: "</script><b>& " });
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain("&");
    expect(out).not.toContain(" ");
    expect(JSON.parse(out)).toEqual({ name: "</script><b>& " });
  });
});

describe("metadata", () => {
  it("sets the canonical, hreflang alternates (x-default Hebrew) and Open Graph", () => {
    const m = pageMetadata({
      locale: "en",
      path: "/works/sunset",
      title: "Sunset",
      description: "d",
      images: [{ url: "/og.jpg", width: 1200, height: 630 }],
    });
    expect(m.alternates).toEqual({
      canonical: "/en/works/sunset",
      languages: {
        he: "/he/works/sunset",
        en: "/en/works/sunset",
        "x-default": "/he/works/sunset",
      },
    });
    expect(m.openGraph).toMatchObject({
      url: "/en/works/sunset",
      locale: "en_US",
      alternateLocale: ["he_IL"],
      images: [{ url: "/og.jpg" }],
    });
    expect(pageMetadata({ locale: "he", path: "/" }).alternates).toMatchObject({
      canonical: "/he",
    });
  });

  it("cuts long descriptions at a word boundary", () => {
    const text = `${"word ".repeat(60)}end`;
    const d = metaDescription(text);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d.endsWith("…")).toBe(true);
    expect(metaDescription("  short\n text ")).toBe("short text");
  });

  it("extracts phone digits for tel: and WhatsApp links", () => {
    expect(phoneDigits("+972-3-000-0000")).toBe("97230000000");
  });
});
