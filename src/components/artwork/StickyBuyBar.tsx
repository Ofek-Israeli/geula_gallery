"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { Link } from "@/i18n/navigation";

/**
 * Mobile sticky buy bar (spec §6.3): title, price or status, and the main call to action, fixed
 * to the bottom with the safe-area inset. Below 768 px only. It hides while the full buy box or
 * the footer (cancellation link) is on screen, so it never covers them; before hydration it is
 * not shown at all (the buy box is always in the page).
 */
export function StickyBuyBar({
  title,
  priceOrStatus,
  href,
  actionLabel,
  primary,
  watchId,
}: {
  title: string;
  priceOrStatus: React.ReactNode;
  href: string;
  actionLabel: string;
  /** Buy now is the primary style; questions use the secondary style. */
  primary: boolean;
  /** The element (the buy box) whose visibility hides the bar. */
  watchId: string;
}) {
  const t = useTranslations("artwork.sticky");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const targets = [
      document.getElementById(watchId),
      document.querySelector("body > footer, footer"),
    ].filter((el): el is HTMLElement => el instanceof HTMLElement);
    if (targets.length === 0 || !("IntersectionObserver" in window)) return;
    const onScreen = new Map<Element, boolean>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) onScreen.set(e.target, e.isIntersecting);
      setVisible(![...onScreen.values()].some(Boolean));
    });
    for (const el of targets) io.observe(el);
    return () => io.disconnect();
  }, [watchId]);

  return (
    <section
      aria-label={t("label")}
      hidden={!visible}
      inert={!visible}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper/95 px-4 pt-3 pbe-safe shadow-[0_-2px_8px_rgba(0,0,0,0.06)] backdrop-blur md:hidden"
      data-testid="sticky-buy-bar"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 pb-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-serif">{title}</span>
          <span className="text-sm">{priceOrStatus}</span>
        </div>
        <Link
          href={href}
          className={buttonClasses(
            primary ? "primary" : "secondary",
            "md",
            "shrink-0",
          )}
        >
          {actionLabel}
        </Link>
      </div>
    </section>
  );
}
