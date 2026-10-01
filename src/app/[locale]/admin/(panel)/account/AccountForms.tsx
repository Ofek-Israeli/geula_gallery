"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { getAuthClient } from "@/lib/auth-client";

type Msg = { ok: boolean; text: string } | null;

function Status({ msg, testId }: { msg: Msg; testId: string }) {
  if (!msg) return null;
  return (
    <p
      role={msg.ok ? "status" : "alert"}
      className={msg.ok ? "text-sm" : "text-sm font-medium text-reddot"}
      data-testid={testId}
    >
      {msg.text}
    </p>
  );
}

/**
 * Password change (spec §6.10 `/admin/account`) through the Better Auth client (`/api/auth/*`, so
 * its rate limits apply). Other sessions are revoked.
 */
export function ChangePasswordForm() {
  const t = useTranslations("admin-shell.account");
  const id = useId();
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, setPending] = useState(false);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    if (newPassword.length < 12)
      return setMsg({ ok: false, text: t("tooShort") });
    if (newPassword !== String(data.get("confirmPassword") ?? "")) {
      return setMsg({ ok: false, text: t("mismatch") });
    }
    setPending(true);
    const { error } = await getAuthClient().changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (error) {
      setMsg({
        ok: false,
        text:
          error.status === 400 || error.status === 401
            ? t("wrongPassword")
            : t("failed"),
      });
      return;
    }
    form.reset();
    setMsg({ ok: true, text: t("changed") });
  }
  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4"
      data-testid="change-password"
    >
      <Field id={`${id}-cur`} label={t("currentPassword")} required>
        {(c) => (
          <Input
            {...c}
            name="currentPassword"
            type="password"
            autoComplete="current-password"
          />
        )}
      </Field>
      <Field
        id={`${id}-new`}
        label={t("newPassword")}
        hint={t("newPasswordHint")}
        required
      >
        {(c) => (
          <Input
            {...c}
            name="newPassword"
            type="password"
            autoComplete="new-password"
          />
        )}
      </Field>
      <Field id={`${id}-again`} label={t("confirmPassword")} required>
        {(c) => (
          <Input
            {...c}
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClasses()} disabled={pending}>
          {t("changePassword")}
        </button>
        <Status msg={msg} testId="password-result" />
      </div>
    </form>
  );
}

/** Disable TOTP (refused by the page when 2FA is required) and regenerate backup codes. */
export function TwoFactorManage({ canDisable }: { canDisable: boolean }) {
  const t = useTranslations("admin-shell.account");
  const id = useId();
  const [msg, setMsg] = useState<Msg>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);

  async function run(
    event: FormEvent<HTMLFormElement>,
    kind: "disable" | "codes",
  ) {
    event.preventDefault();
    const password = String(
      new FormData(event.currentTarget).get("password") ?? "",
    );
    setPending(true);
    setMsg(null);
    if (kind === "disable") {
      const { error } = await getAuthClient().twoFactor.disable({ password });
      setPending(false);
      if (error) return setMsg({ ok: false, text: t("wrongPassword") });
      window.location.reload();
      return;
    }
    const { data, error } = await getAuthClient().twoFactor.generateBackupCodes(
      { password },
    );
    setPending(false);
    if (error || !data) return setMsg({ ok: false, text: t("wrongPassword") });
    setCodes(data.backupCodes);
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={(e) => run(e, "codes")} className="flex flex-col gap-3">
        <h3 className="font-sans font-semibold">{t("backupCodes")}</h3>
        <p className="text-sm text-ink-muted">{t("backupHint")}</p>
        <Field id={`${id}-pw1`} label={t("currentPassword")} required>
          {(c) => (
            <Input
              {...c}
              name="password"
              type="password"
              autoComplete="current-password"
            />
          )}
        </Field>
        <div>
          <button
            type="submit"
            className={buttonClasses("secondary")}
            disabled={pending}
          >
            {t("generate")}
          </button>
        </div>
      </form>
      {codes ? (
        <div role="status" className="flex flex-col gap-2">
          <p>{t("generated")}</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm" dir="ltr">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {canDisable ? (
        <form
          onSubmit={(e) => run(e, "disable")}
          className="flex flex-col gap-3"
        >
          <Field id={`${id}-pw2`} label={t("currentPassword")} required>
            {(c) => (
              <Input
                {...c}
                name="password"
                type="password"
                autoComplete="current-password"
              />
            )}
          </Field>
          <div>
            <button
              type="submit"
              className={buttonClasses("danger")}
              disabled={pending}
            >
              {t("disable")}
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-ink-muted">{t("twoFactorRequired")}</p>
      )}
      <Status msg={msg} testId="two-factor-result" />
    </div>
  );
}
