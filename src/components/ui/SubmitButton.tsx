"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { type ButtonProps, buttonClasses } from "./Button";

/**
 * Submit button that disables itself while its form is pending (double-submit guard; the server
 * still enforces idempotency).
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant,
  size,
  className,
  disabled,
  ...props
}: Omit<ButtonProps, "type"> & { pendingLabel?: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-disabled={pending || disabled ? true : undefined}
      className={buttonClasses(variant, size, className)}
      {...props}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
