import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export type BadgeTone = "neutral" | "available" | "hold" | "sold" | "danger";

/**
 * Status badge. Status is always conveyed as text (spec §6.7); colour and the red dot are
 * decoration only.
 */
export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-sm",
        tone === "neutral" && "border-line text-ink-muted",
        tone === "available" && "border-line text-ink",
        tone === "hold" && "border-hold text-hold",
        tone === "sold" && "border-line text-ink",
        tone === "danger" && "border-reddot text-reddot",
        className,
      )}
    >
      {tone === "sold" ? (
        <span aria-hidden="true" className="size-2.5 rounded-full bg-reddot" />
      ) : null}
      {children}
    </span>
  );
}
