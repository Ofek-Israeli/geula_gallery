"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef } from "react";

export interface FormErrorItem {
  /** The id of the invalid control; the summary links to it. */
  fieldId?: string;
  message: string;
}

/**
 * Error summary shown above a form after a failed submit (spec §6.7). It takes focus when it
 * appears so screen-reader and keyboard users land on it; each item links to its field.
 */
export function ErrorSummary({
  errors,
  title,
}: {
  errors: readonly FormErrorItem[];
  title?: string;
}) {
  const t = useTranslations("common.form");
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (errors.length > 0) ref.current?.focus();
  }, [errors]);

  if (errors.length === 0) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-labelledby={titleId}
      className="rounded-sm border-2 border-reddot bg-white p-4"
    >
      <h2 id={titleId} className="font-sans text-base font-semibold">
        {title ?? t("errorSummaryTitle", { count: errors.length })}
      </h2>
      <ul className="mbs-2 list-disc ps-5">
        {errors.map((e) => (
          <li key={`${e.fieldId ?? ""}:${e.message}`}>
            {e.fieldId ? (
              <a href={`#${e.fieldId}`} className="underline">
                {e.message}
              </a>
            ) : (
              e.message
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
