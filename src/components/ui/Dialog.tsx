"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useId, useRef } from "react";
import { type ButtonSize, type ButtonVariant, buttonClasses } from "./Button";

/**
 * Native `<dialog>` opened with `showModal()` (spec §6.3 components/ui). The browser handles the
 * focus trap, Escape and returning focus to the trigger.
 */
export function Dialog({
  title,
  triggerLabel,
  triggerVariant = "secondary",
  triggerSize,
  children,
}: {
  title: ReactNode;
  triggerLabel: ReactNode;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  children: ReactNode;
}) {
  const t = useTranslations("common.form");
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return (
    <>
      <button
        type="button"
        className={buttonClasses(triggerVariant, triggerSize)}
        aria-haspopup="dialog"
        onClick={() => ref.current?.showModal()}
      >
        {triggerLabel}
      </button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-sm border border-line bg-paper p-0 text-ink"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line p-4">
          <h2 id={titleId} className="text-xl">
            {title}
          </h2>
          <button
            type="button"
            className={buttonClasses("ghost", "sm")}
            onClick={() => ref.current?.close()}
          >
            {t("close")}
          </button>
        </div>
        <div className="p-4">{children}</div>
      </dialog>
    </>
  );
}
