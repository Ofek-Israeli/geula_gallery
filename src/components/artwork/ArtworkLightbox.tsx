"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import Lightbox, { type SlideImage } from "yet-another-react-lightbox";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/counter.css";

/**
 * `ArtworkLightbox` (spec §6.3, §6.7): yet-another-react-lightbox 3.32.2 with Zoom and Counter,
 * loaded only when the buyer opens it (`next/dynamic` in `ArtworkGallery`). APG modal dialog:
 * focus moves into it, Esc closes, arrow keys follow the page direction (mirrored in Hebrew: the
 * library reads the computed `direction`), and the gallery returns focus to the trigger on close.
 * A polite live region inside the dialog announces "תמונה 2 מתוך 5" on every slide change.
 */
export default function ArtworkLightbox({
  open,
  slides,
  index,
  onClose,
  onExited,
}: {
  open: boolean;
  slides: SlideImage[];
  index: number;
  onClose: () => void;
  onExited: () => void;
}) {
  const t = useTranslations("artwork.lightbox");
  const total = slides.length;
  const position = (i: number) => t("position", { index: i + 1, total });
  const [live, setLive] = useState(() => position(index));
  const [shownFor, setShownFor] = useState(index);
  if (open && shownFor !== index) {
    // Re-opened at another image: reset the announcement.
    setShownFor(index);
    setLive(position(index));
  }

  return (
    <Lightbox
      open={open}
      close={onClose}
      index={index}
      slides={slides}
      plugins={[Zoom, Counter]}
      controller={{ aria: true, closeOnBackdropClick: true }}
      carousel={{ finite: true }}
      animation={{ fade: 200 }}
      zoom={{ maxZoomPixelRatio: 2, scrollToZoom: true }}
      counter={{ container: { "aria-hidden": true } }}
      labels={{
        Previous: t("previous"),
        Next: t("next"),
        Close: t("close"),
        "Zoom in": t("zoomIn"),
        "Zoom out": t("zoomOut"),
        Lightbox: t("label"),
        "Photo gallery": t("gallery"),
        Carousel: t("carousel"),
        Slide: t("slide"),
        // The library fills these placeholders itself.
        "{index} of {total}": t("position", {
          index: "{index}",
          total: "{total}",
        }),
      }}
      on={{
        view: ({ index: i }) => setLive(position(i)),
        exited: onExited,
      }}
      render={{
        controls: () => (
          <p
            className="sr-only"
            aria-live="polite"
            aria-atomic="true"
            data-testid="lightbox-live"
          >
            {live}
          </p>
        ),
        ...(total <= 1
          ? { buttonPrev: () => null, buttonNext: () => null }
          : {}),
      }}
      styles={{
        container: { backgroundColor: "rgba(29, 28, 26, 0.96)" },
      }}
    />
  );
}
