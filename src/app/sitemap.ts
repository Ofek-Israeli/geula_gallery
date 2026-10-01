import type { MetadataRoute } from "next";
import { LOCALE_VALUES } from "@/lib/locale";
import { absoluteUrl, LEGAL_DOCS, localePath, paths } from "@/lib/routes";
import { listSitemapArtworks } from "@/server/catalog/queries";
import { env } from "@/server/env";

/**
 * `/sitemap.xml` (spec §6.6): dynamic (read per request, like every page; spec §1.4), one entry
 * per page and locale with hreflang alternates (`he`, `en`, `x-default` → Hebrew) and, for works,
 * their image URLs. Private pages (checkout, orders, cancel, print, admin) are not listed.
 */
export const dynamic = "force-dynamic";

const STATIC_PAGES = [
  paths.home(),
  paths.works(),
  paths.works({ availability: "sold" }),
  paths.about(),
  paths.contact(),
  paths.credits(),
  ...LEGAL_DOCS.map((doc) => paths.legal(doc)),
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = env.APP_URL;
  const url = (path: string) => absoluteUrl(base, path);
  const entries = (
    path: string,
    extra: Omit<MetadataRoute.Sitemap[number], "url"> = {},
  ): MetadataRoute.Sitemap => {
    const languages = {
      he: url(localePath("he", path)),
      en: url(localePath("en", path)),
      "x-default": url(localePath("he", path)),
    };
    return LOCALE_VALUES.map((locale) => ({
      url: url(localePath(locale, path)),
      alternates: { languages },
      ...extra,
    }));
  };

  const artworks = await listSitemapArtworks();
  return [
    ...STATIC_PAGES.flatMap((path) => entries(path)),
    ...artworks.flatMap((a) =>
      entries(paths.artwork(a.slug), {
        lastModified: a.lastModified,
        images: a.images.map(url),
      }),
    ),
  ];
}
