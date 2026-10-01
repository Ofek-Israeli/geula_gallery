import type { TextareaHTMLAttributes } from "react";
import { cx } from "@/lib/cx";
import { controlClasses } from "./Input";

export function Textarea({
  className,
  dir = "auto",
  rows = 5,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      dir={dir}
      rows={rows}
      className={cx(controlClasses, "min-h-24", className)}
      {...props}
    />
  );
}
