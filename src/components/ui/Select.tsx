import type { SelectHTMLAttributes } from "react";
import { cx } from "@/lib/cx";
import { controlClasses } from "./Input";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Select({
  options,
  placeholder,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  options: readonly SelectOption[];
  placeholder?: string;
}) {
  return (
    <select className={cx(controlClasses, className)} {...props}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
