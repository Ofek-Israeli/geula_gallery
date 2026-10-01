import type { Metadata } from "next";
import type { Locale } from "@/lib/locale";
import { localePath } from "@/lib/routes";

const OG_LOCALE: Record<Locale, string> = { he: "he_IL", en: "en_US" };

/**
 * Per-page metadata (spec §6.6): per-locale canonical, hreflang alternates (`he`, `en`,
 * `x-default` → Hebrew) and Open Graph. URLs are relative; the root layout's `metadataBase`
 * (`APP_URL`) makes them absolute. `path` is locale-less (`paths.*`).
 */
export function pageMetadata({
  locale,
  path,
  title,
  description,
  images,
  type = "website",
  absoluteTitle = false,
}: {
  locale: Locale;
  path: string;
  title?: string;
  description?: string;
  images?: { url: string; width?: number; height?: number; alt?: string }[];
  type?: "website" | "article";
  /** Use `title` as is (no "· site name" template), e.g. on the home page. */
  absoluteTitle?: boolean;
}): Metadata {
  const canonical = localePath(locale, path);
  return {
    ...(title !== undefined
      ? { title: absoluteTitle ? { absolute: title } : title }
      : {}),
    ...(description !== undefined ? { description } : {}),
    alternates: {
      canonical,
      languages: {
        he: localePath("he", path),
        en: localePath("en", path),
        "x-default": localePath("he", path),
      },
    },
    openGraph: {
      type,
      url: canonical,
      locale: OG_LOCALE[locale],
      alternateLocale: [OG_LOCALE[locale === "he" ? "en" : "he"]],
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(images && images.length > 0 ? { images } : {}),
    },
    twitter: {
      card: images && images.length > 0 ? "summary_large_image" : "summary",
    },
  };
}

/** Plain text for a meta description: whitespace collapsed, cut at a word boundary (≤ 160). */
export function metaDescription(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
