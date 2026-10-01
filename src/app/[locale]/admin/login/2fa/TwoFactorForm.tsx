"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { getAuthClient } from "@/lib/auth-client";
import type { Locale } from "@/lib/locale";

export function TwoFactorForm({
  locale,
  next,
}: {
  locale: Locale;
  next: string;
}) {
  const t = useTranslations("admin-shell.twoFactor");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(
      new FormData(event.currentTarget).get("code") ?? "",
    ).trim();
    setPending(true);
    setError(null);
    const client = getAuthClient();
    const { error: failure } = useBackup
      ? await client.twoFactor.verifyBackupCode({ code })
      : await client.twoFactor.verifyTotp({ code: code.replace(/\s+/g, "") });
    if (failure) {
      setError(
        failure.status === 429
          ? t("rateLimited")
          : /COOKIE|SESSION|EXPIRED/i.test(failure.code ?? "")
            ? t("expired")
            : t("invalid"),
      );
      setPending(false);
      return;
    }
    window.location.assign(next);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <p>{t("intro")}</p>
      {error ? (
        <p
          role="alert"
          className="rounded-sm border-2 border-reddot p-3 font-medium"
        >
          {error}
        </p>
      ) : null}
      <Field id="code" label={useBackup ? t("backupCode") : t("code")} required>
        {(control) => (
          <Input
            {...control}
            key={useBackup ? "backup" : "totp"}
            name="code"
            dir="ltr"
            autoComplete="one-time-code"
            inputMode={useBackup ? "text" : "numeric"}
            pattern={useBackup ? undefined : "[0-9 ]{6,7}"}
            maxLength={useBackup ? 32 : 7}
          />
        )}
      </Field>
      <button
        type="submit"
        className={buttonClasses("primary")}
        disabled={pending}
        aria-disabled={pending || undefined}
      >
        {pending ? t("submitting") : t("submit")}
      </button>
      <button
        type="button"
        className={buttonClasses("ghost", "sm")}
        onClick={() => {
          setUseBackup((v) => !v);
          setError(null);
        }}
      >
        {useBackup ? t("useTotp") : t("useBackup")}
      </button>
      <a href={`/${locale}/admin/login`} className="text-sm underline">
        {t("backToLogin")}
      </a>
    </form>
  );
}
