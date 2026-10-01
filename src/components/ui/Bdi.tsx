import type { ReactNode } from "react";

/**
 * Bidi isolation for prices, dimensions, emails, phones, URLs and order numbers (spec §6.4).
 * Defaults to `dir="ltr"`: these values are never mirrored.
 */
export function Bdi({
  children,
  dir = "ltr",
  className,
}: {
  children: ReactNode;
  dir?: "ltr" | "rtl" | "auto";
  className?: string;
}) {
  return (
    <bdi dir={dir} className={className}>
      {children}
    </bdi>
  );
}
