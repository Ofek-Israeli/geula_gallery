import { getImageProps } from "next/image";
import { preload } from "react-dom";
import type { ArtworkImageDTO } from "@/lib/catalog";
import { cx } from "@/lib/cx";

/** Optimised URLs (1x / 2x) for the painting as a CSS background. */
function backgroundSet(image: ArtworkImageDTO) {
  const {
    props: { src, srcSet = "" },
  } = getImageProps({
    src: image.src,
    alt: "",
    width: 1920,
    height: Math.round((1920 * image.height) / image.width),
    quality: 75,
  });
  const imageSet = srcSet
    .split(", ")
    .map((entry) => {
      const [url, density] = entry.split(" ");
      return `url("${url}") ${density}`;
    })
    .join(", ");
  return { src, srcSet, css: `image-set(${imageSet})` };
}

/**
 * One painting behind the whole page, seen through "windows": the home page's quote band and the
 * site footer. Each band paints it as its own CSS background with `background-attachment: fixed`
 * and `cover`, so the painting is sized and placed against the viewport and stays still while the
 * page scrolls: the top band shows its upper part, and the footer, reached at the bottom of the
 * viewport, shows where it continues. A background can never spill outside its band (unlike a
 * fixed `<img>` clipped with `clip-path`, which real Safari does not clip reliably).
 *
 * The fixed window applies only with a fine pointer and without `prefers-reduced-motion` (touch
 * browsers ignore or mis-scale fixed backgrounds); otherwise each band shows its own crop
 * (`fallback` = which part). Both windows use the same URLs, so the image is
 * downloaded once; the band marked `priority` (the home page's LCP) preloads it. The band must be
 * `relative isolate overflow-hidden bg-ink`. Decorative; the `ink/65` overlay keeps the light text
 * above 4.5:1.
 */
export function PaintingBackdrop({
  image,
  priority = false,
  fallback = "center",
}: {
  image: ArtworkImageDTO;
  /** The page's LCP image (the home band). */
  priority?: boolean;
  fallback?: "center" | "bottom";
}) {
  const bg = backgroundSet(image);
  if (priority) {
    preload(bg.src, {
      as: "image",
      imageSrcSet: bg.srcSet,
      fetchPriority: "high",
    });
  }
  const layers = image.blurDataUrl
    ? `${bg.css}, url("${image.blurDataUrl}")`
    : bg.css;
  return (
    <>
      <div
        aria-hidden="true"
        className={cx(
          "absolute inset-0 -z-20 bg-scroll bg-cover bg-no-repeat",
          // The window effect only with a mouse and without reduced motion: touch browsers
          // (iOS) ignore or mis-scale fixed backgrounds.
          "pointer-fine:motion-safe:bg-fixed pointer-fine:motion-safe:bg-center",
          fallback === "bottom" ? "bg-bottom" : "bg-center",
        )}
        style={{ backgroundImage: layers }}
        data-testid="painting-backdrop"
      />
      <div className="absolute inset-0 -z-10 bg-ink/65" aria-hidden="true" />
    </>
  );
}
