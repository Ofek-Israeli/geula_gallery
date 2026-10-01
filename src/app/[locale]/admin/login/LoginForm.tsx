"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { getAuthClient } from "@/lib/auth-client";
import type { Locale } from "@/lib/locale";

export function LoginForm({ locale, next }: { locale: Locale; next: string }) {
  const t = useTranslations("admin-shell.login");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { data, error: failure } = await getAuthClient().signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (failure) {
      setError(
        failure.status === 429
          ? t("rateLimited")
          : failure.status === 401 || failure.status === 400
            ? t("invalid")
            : t("failed"),
      );
      setPending(false);
      return;
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      window.location.assign(
        `/${locale}/admin/login/2fa?next=${encodeURIComponent(next)}`,
      );
      return;
    }
    // Full navigation so the new session cookie is sent with the next request.
    window.location.assign(next);
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4"
      noValidate={false}
    >
      {error ? (
        <p
          role="alert"
          className="rounded-sm border-2 border-reddot p-3 font-medium"
        >
          {error}
        </p>
      ) : null}
      <Field id="email" label={t("email")} required>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="username"
          />
        )}
      </Field>
      <Field id="password" label={t("password")} required>
        {(control) => (
          <Input
            {...control}
            name="password"
            type="password"
            autoComplete="current-password"
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
    </form>
  );
}
