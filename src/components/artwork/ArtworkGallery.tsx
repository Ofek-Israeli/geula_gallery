"use client";

import dynamic from "next/dynamic";
import Image, { getImageProps } from "next/image";
import { useTranslations } from "next-intl";
import { type UIEvent, useMemo, useRef, useState } from "react";
import type { SlideImage } from "yet-another-react-lightbox";
import { cx } from "@/lib/cx";

/** The lightbox chunk (library + CSS) loads on first open only (spec §6.3 "lazy-loaded"). */
const ArtworkLightbox = dynamic(() => import("./ArtworkLightbox"), {
  ssr: false,
});

export interface GalleryImage {
  id: string;
  src: string;
  width: number;
  height: number;
  alt: string;
  blurDataUrl: string | null;
}

const MAIN_SIZES = "(min-width:768px) 60vw, 100vw";

/** Lightbox slides from `getImageProps()` at q90 (spec §6.3), with a width-based `srcSet`. */
export function lightboxSlides(images: GalleryImage[]): SlideImage[] {
  return images.map((img) => {
    const { props } = getImageProps({
      src: img.src,
      alt: img.alt,
      width: img.width,
      height: img.height,
      quality: 90,
      sizes: "100vw",
    });
    const srcSet = (props.srcSet ?? "")
      .split(", ")
      .map((entry) => {
        const [url, w] = entry.trim().split(" ");
        const width = Number.parseInt(w ?? "", 10);
        return url && Number.isFinite(width)
          ? {
              src: url,
              width,
              height: Math.round((width * img.height) / img.width),
            }
          : null;
      })
      .filter((s): s is { src: string; width: number; height: number } =>
        Boolean(s),
      );
    return {
      src: props.src,
      alt: img.alt,
      width: img.width,
      height: img.height,
      srcSet,
    };
  });
}

/**
 * The artwork's images (spec §6.3): on mobile a scroll-snap strip with a counter; from 768 px the
 * selected image large with thumbnails below. Every image opens the lightbox; the first is the LCP
 * (`loading="eager"`, `fetchPriority="high"`). Images are never cropped.
 */
export function ArtworkGallery({
  images,
  title,
  caption,
}: {
  images: GalleryImage[];
  title: string;
  /** Rendered under the images (e.g. the AIC credit line), already bidi-isolated. */
  caption?: React.ReactNode;
}) {
  const t = useTranslations("artwork.gallery");
  const total = images.length;
  const [selected, setSelected] = useState(0);
  const [scrolled, setScrolled] = useState(0);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  /** Mount the lazy lightbox on first use only, then keep it for the close animation. */
  const [loaded, setLoaded] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const slides = useMemo(() => lightboxSlides(images), [images]);

  function openAt(i: number, el: HTMLElement) {
    trigger.current = el;
    setIndex(i);
    setLoaded(true);
    setOpen(true);
  }

  function onStripScroll(e: UIEvent<HTMLUListElement>) {
    const el = e.currentTarget;
    // scrollLeft is negative in RTL (Chromium, Firefox, Safari): use the magnitude.
    const i = Math.round(Math.abs(el.scrollLeft) / Math.max(1, el.clientWidth));
    setScrolled(Math.min(total - 1, Math.max(0, i)));
  }

  if (total === 0) return null;

  return (
    <figure className="flex min-w-0 flex-col gap-3" aria-label={title}>
      <ul
        className="relative flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain [scrollbar-width:none] md:overflow-visible"
        aria-label={t("label")}
        onScroll={onStripScroll}
        data-testid="gallery-strip"
      >
        {images.map((img, i) => (
          <li
            key={img.id}
            className={cx(
              "w-full shrink-0 snap-center",
              i !== selected && "md:hidden",
            )}
          >
            <button
              type="button"
              onClick={(e) => openAt(i, e.currentTarget)}
              className="block w-full cursor-zoom-in"
              data-testid={i === 0 ? "gallery-open" : undefined}
            >
              <Image
                src={img.src}
                alt={img.alt}
                width={img.width}
                height={img.height}
                sizes={MAIN_SIZES}
                quality={90}
                loading={i === 0 ? "eager" : "lazy"}
                fetchPriority={i === 0 ? "high" : "auto"}
                placeholder={img.blurDataUrl ? "blur" : "empty"}
                blurDataURL={img.blurDataUrl ?? undefined}
                className="h-auto max-h-[85vh] w-full object-contain"
              />
              <span className="sr-only">
                {total > 1
                  ? t("enlargeOf", { index: i + 1, total })
                  : t("enlarge")}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {total > 1 ? (
        <>
          <p
            className="text-center text-sm text-ink-muted md:hidden"
            aria-hidden="true"
            data-testid="gallery-counter"
          >
            {t("counter", { index: scrolled + 1, total })}
          </p>
          <ul
            className="hidden flex-wrap gap-2 md:flex"
            aria-label={t("thumbnails")}
          >
            {images.map((img, i) => (
              <li key={img.id}>
                <button
                  type="button"
                  aria-pressed={i === selected}
                  onClick={() => setSelected(i)}
                  className={cx(
                    "block size-20 border p-0.5",
                    i === selected ? "border-ink" : "border-line",
                  )}
                >
                  <Image
                    src={img.src}
                    alt=""
                    width={img.width}
                    height={img.height}
                    sizes="80px"
                    quality={75}
                    className="size-full object-contain"
                  />
                  <span className="sr-only">
                    {t("show", { index: i + 1, total })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {caption ? (
        <figcaption className="text-sm text-ink-muted">{caption}</figcaption>
      ) : null}

      {loaded ? (
        <ArtworkLightbox
          open={open}
          slides={slides}
          index={index}
          onClose={() => setOpen(false)}
          onExited={() => trigger.current?.focus()}
        />
      ) : null}
    </figure>
  );
}
