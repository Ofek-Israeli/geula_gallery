"use client";

import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { type FormEvent, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { getAuthClient } from "@/lib/auth-client";
import type { Locale } from "@/lib/locale";

interface Enrollment {
  qrDataUrl: string;
  secret: string;
  backupCodes: string[];
}

export function EnrollForm({ locale }: { locale: Locale }) {
  const t = useTranslations("admin-shell.enroll");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(
      new FormData(event.currentTarget).get("password") ?? "",
    );
    setPending(true);
    setError(null);
    const { data, error: failure } = await getAuthClient().twoFactor.enable({
      password,
      method: "totp",
    });
    if (failure || !data || data.method !== "totp") {
      setError(
        failure?.status === 400 || failure?.status === 401
          ? t("invalidPassword")
          : t("failed"),
      );
      setPending(false);
      return;
    }
    const secret = new URL(data.totpURI).searchParams.get("secret") ?? "";
    const qrDataUrl = await QRCode.toDataURL(data.totpURI, {
      margin: 1,
      width: 240,
    });
    setEnrollment({ qrDataUrl, secret, backupCodes: data.backupCodes });
    setPending(false);
  }

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(
      new FormData(event.currentTarget).get("code") ?? "",
    ).replace(/\s+/g, "");
    setPending(true);
    setError(null);
    const { error: failure } = await getAuthClient().twoFactor.verifyTotp({
      code,
    });
    if (failure) {
      setError(t("invalidCode"));
      setPending(false);
      return;
    }
    window.location.assign(`/${locale}/admin`);
  }

  const alert = error ? (
    <p
      role="alert"
      className="rounded-sm border-2 border-reddot p-3 font-medium"
    >
      {error}
    </p>
  ) : null;

  if (!enrollment) {
    return (
      <form onSubmit={onStart} className="flex flex-col gap-4">
        {alert}
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
        >
          {t("start")}
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p>{t("scan")}</p>
      {/* biome-ignore lint/performance/noImgElement: a local data: URL QR code, not a content image */}
      <img
        src={enrollment.qrDataUrl}
        alt={t("qrAlt")}
        width={240}
        height={240}
        className="self-center border border-line bg-white"
      />
      <div>
        <p className="font-medium">{t("secret")}</p>
        <code
          dir="ltr"
          className="block break-all rounded-sm bg-wall p-2 font-mono"
        >
          {enrollment.secret}
        </code>
      </div>
      <section aria-labelledby="backup-title" className="flex flex-col gap-2">
        <h2 id="backup-title" className="text-xl">
          {t("backupTitle")}
        </h2>
        <p className="text-sm text-ink-muted">{t("backupHint")}</p>
        <ul dir="ltr" className="grid grid-cols-2 gap-1 font-mono">
          {enrollment.backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      </section>
      <form onSubmit={onVerify} className="flex flex-col gap-4">
        {alert}
        <Field id="code" label={t("code")} required>
          {(control) => (
            <Input
              {...control}
              name="code"
              dir="ltr"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9 ]{6,7}"
              maxLength={7}
            />
          )}
        </Field>
        <button
          type="submit"
          className={buttonClasses("primary")}
          disabled={pending}
        >
          {pending ? t("submitting") : t("verify")}
        </button>
      </form>
    </div>
  );
}
