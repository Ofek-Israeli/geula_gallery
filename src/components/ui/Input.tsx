import type { InputHTMLAttributes } from "react";
import { cx } from "@/lib/cx";

export const controlClasses =
  "min-h-11 w-full rounded-sm border border-line bg-white px-3 py-2 text-ink placeholder:text-ink-muted aria-invalid:border-reddot";

const LTR_TYPES = new Set(["email", "tel", "url", "number", "password"]);

/**
 * Text input. `dir="auto"` by default; email, phone, URL, number and password inputs are LTR
 * (spec §6.4). Pass `dir="ltr"` for ID numbers.
 */
export function Input({
  className,
  type = "text",
  dir,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      dir={dir ?? (LTR_TYPES.has(type) ? "ltr" : "auto")}
      className={cx(controlClasses, className)}
      {...props}
    />
  );
}
