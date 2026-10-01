import { useTranslations } from "next-intl";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "@/lib/cx";
import { describedBy, errorId, hintId } from "./Field";

/** A checkbox with its label to the inline-end side, plus optional hint and error. */
export function Checkbox({
  id,
  label,
  hint,
  error,
  required,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  const t = useTranslations("common.form");
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, { hint, error })}
          className="mt-1 size-5 shrink-0 accent-ink"
          {...props}
        />
        <label htmlFor={id}>
          {label}
          {required ? (
            <span className="ms-1 text-ink-muted">{t("required")}</span>
          ) : null}
        </label>
      </div>
      {hint ? (
        <p id={hintId(id)} className="ps-8 text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId(id)} className="ps-8 text-sm font-medium text-reddot">
          {error}
        </p>
      ) : null}
    </div>
  );
}
