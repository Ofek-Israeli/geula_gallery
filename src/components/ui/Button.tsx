import type { ButtonHTMLAttributes } from "react";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

/** Shared button styling (also used for links styled as buttons). Targets ≥ 44 px (md) / 24 px (sm). */
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-sm border font-medium no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    size === "md" ? "min-h-11 px-5 py-2" : "min-h-8 px-3 py-1 text-sm",
    variant === "primary" &&
      "border-ink bg-ink text-paper hover:bg-ink-muted hover:border-ink-muted",
    variant === "secondary" &&
      "border-ink bg-transparent text-ink hover:bg-wall",
    variant === "ghost" &&
      "border-transparent bg-transparent text-ink underline hover:bg-wall",
    variant === "danger" &&
      "border-reddot bg-reddot text-paper hover:opacity-90",
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, className)}
      {...props}
    />
  );
}
