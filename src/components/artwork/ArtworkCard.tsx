import Image from "next/image";
import { useLocale } from "next-intl";
import { Dimensions } from "@/components/ui/Dimensions";
import { Link } from "@/i18n/navigation";
import type { ArtworkCardDTO } from "@/lib/catalog";
import type { Locale } from "@/lib/locale";
import { paths } from "@/lib/routes";
import { ArtworkStatus } from "./ArtworkStatus";

export const GRID_SIZES =
  "(min-width:1280px) 30vw, (min-width:768px) 45vw, 100vw";

/**
 * One work in a grid: the uncropped image (never placed on colour; the dominant colour only shows
 * while loading), then a visible caption: title, year, medium, dimensions and price or status.
 */
export function ArtworkCard({
  artwork,
  priority = false,
  headingLevel = 2,
}: {
  artwork: ArtworkCardDTO;
  priority?: boolean;
  headingLevel?: 2 | 3;
}) {
  const locale = useLocale() as Locale;
  const href = paths.artwork(artwork.slug);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="flex flex-col gap-2">
      {artwork.image ? (
        <Link href={href} tabIndex={-1} aria-hidden="true" className="block">
          <Image
            src={artwork.image.src}
            alt={artwork.image.alt}
            width={artwork.image.width}
            height={artwork.image.height}
            sizes={GRID_SIZES}
            quality={75}
            className="fade-in h-auto w-full"
            style={{
              backgroundColor: artwork.image.dominantColor ?? undefined,
            }}
            placeholder={artwork.image.blurDataUrl ? "blur" : "empty"}
            blurDataURL={artwork.image.blurDataUrl ?? undefined}
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : "auto"}
          />
        </Link>
      ) : null}
      <div className="flex flex-col gap-0.5 text-base">
        <Heading className="font-serif text-lg leading-snug">
          <Link href={href} className="no-underline hover:underline">
            {artwork.title}
          </Link>
        </Heading>
        <p className="text-sm text-ink-muted">
          {[artwork.year, artwork.mediumText].filter(Boolean).join(" · ")}
        </p>
        <p className="text-sm text-ink-muted">
          <Dimensions
            locale={locale}
            heightMm={artwork.heightMm}
            widthMm={artwork.widthMm}
            depthMm={artwork.depthMm}
          />
        </p>
        <div className="mt-1">
          <ArtworkStatus state={artwork.state} price={artwork.price} />
        </div>
      </div>
    </article>
  );
}
