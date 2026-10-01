"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useId, useRef } from "react";
import { type ButtonVariant, buttonClasses } from "./Button";

/**
 * A button that asks for confirmation in a native modal before submitting its enclosing form.
 * Place it inside the `<form>`; the confirm button is a real submit button (works with Server
 * Actions; `name`/`value` are submitted with it).
 */
export function ConfirmButton({
  children,
  title,
  message,
  confirmLabel,
  variant = "danger",
  name,
  value,
}: {
  children: ReactNode;
  title?: ReactNode;
  message: ReactNode;
  confirmLabel?: ReactNode;
  variant?: ButtonVariant;
  name?: string;
  value?: string;
}) {
  const t = useTranslations("common.form");
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();
  return (
    <>
      <button
        type="button"
        className={buttonClasses(variant)}
        aria-haspopup="dialog"
        onClick={() => ref.current?.showModal()}
      >
        {children}
      </button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-sm border border-line bg-paper p-5 text-ink"
      >
        <h2 id={titleId} className="text-xl">
          {title ?? t("confirmTitle")}
        </h2>
        <div id={messageId} className="mbs-2">
          {message}
        </div>
        <div className="mbs-5 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            className={buttonClasses("secondary")}
            onClick={() => ref.current?.close()}
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            name={name}
            value={value}
            className={buttonClasses(variant)}
            onClick={() => ref.current?.close()}
          >
            {confirmLabel ?? t("confirm")}
          </button>
        </div>
      </dialog>
    </>
  );
}
