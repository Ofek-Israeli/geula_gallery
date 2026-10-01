import { useTranslations } from "next-intl";
import { HONEYPOT_FIELD } from "@/lib/forms";

/**
 * Anti-spam honeypot (spec §7). Off-screen and hidden from assistive technology; never focusable.
 * `publicAction` rejects submissions where it is filled.
 */
export function HoneypotField() {
  const t = useTranslations("common.form");
  return (
    <div
      aria-hidden="true"
      className="absolute -inset-s-[9999px] size-px overflow-hidden"
    >
      <label>
        {t("honeypot")}
        <input
          type="text"
          name={HONEYPOT_FIELD}
          tabIndex={-1}
          autoComplete="off"
          defaultValue=""
        />
      </label>
    </div>
  );
}
