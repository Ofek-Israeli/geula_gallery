import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export interface FieldControlProps {
  id: string;
  required?: boolean;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

export function hintId(id: string): string {
  return `${id}-hint`;
}

export function errorId(id: string): string {
  return `${id}-error`;
}

/** `aria-describedby` for a control with an optional hint and error. */
export function describedBy(
  id: string,
  opts: { hint?: ReactNode; error?: ReactNode },
): string | undefined {
  const ids = [
    opts.hint ? hintId(id) : null,
    opts.error ? errorId(id) : null,
  ].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

/**
 * Visible label + "(חובה)" marker + hint + inline error (spec §6.7). `children` is the control,
 * or a render function receiving the id / aria props to spread on it.
 */
export function Field({
  id,
  label,
  required,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode | ((control: FieldControlProps) => ReactNode);
}) {
  const t = useTranslations("common.form");
  const control: FieldControlProps = {
    id,
    required,
    ...(error ? { "aria-invalid": true as const } : {}),
    ...(describedBy(id, { hint, error })
      ? { "aria-describedby": describedBy(id, { hint, error }) }
      : {}),
  };
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="font-medium">
        {label}
        {required ? (
          <span className="ms-1 font-normal text-ink-muted">
            {t("required")}
          </span>
        ) : null}
      </label>
      {hint ? (
        <p id={hintId(id)} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
      {typeof children === "function" ? children(control) : children}
      {error ? (
        <p id={errorId(id)} className="text-sm font-medium text-reddot">
          {error}
        </p>
      ) : null}
    </div>
  );
}
