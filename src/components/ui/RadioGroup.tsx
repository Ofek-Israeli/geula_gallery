import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { errorId } from "./Field";

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

/** A `<fieldset>` of radios with a visible legend (spec §6.7). */
export function RadioGroup({
  id,
  name,
  legend,
  options,
  defaultValue,
  required,
  error,
  className,
}: {
  id: string;
  name: string;
  legend: ReactNode;
  options: readonly RadioOption[];
  defaultValue?: string;
  required?: boolean;
  error?: ReactNode;
  className?: string;
}) {
  const t = useTranslations("common.form");
  return (
    <fieldset
      id={id}
      className={cx("flex flex-col gap-2", className)}
      aria-describedby={error ? errorId(id) : undefined}
    >
      <legend className="mbe-1 font-medium">
        {legend}
        {required ? (
          <span className="ms-1 font-normal text-ink-muted">
            {t("required")}
          </span>
        ) : null}
      </legend>
      {options.map((o) => {
        const optionId = `${id}-${o.value}`;
        return (
          <div key={o.value} className="flex items-start gap-3">
            <input
              id={optionId}
              type="radio"
              name={name}
              value={o.value}
              defaultChecked={defaultValue === o.value}
              required={required}
              disabled={o.disabled}
              aria-invalid={error ? true : undefined}
              className="mt-1 size-5 shrink-0 accent-ink"
            />
            <label htmlFor={optionId} className="flex flex-col">
              <span>{o.label}</span>
              {o.description ? (
                <span className="text-sm text-ink-muted">{o.description}</span>
              ) : null}
            </label>
          </div>
        );
      })}
      {error ? (
        <p id={errorId(id)} className="text-sm font-medium text-reddot">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
