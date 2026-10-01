"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { apiPaths } from "@/lib/routes";

/**
 * Photo upload for the artwork editor (spec §6.10 "Photos (`purpose=artwork` uploads …)"). Posts
 * the file to the frozen upload route (`POST /api/admin/uploads?purpose=artwork`, same origin,
 * admin session), then refreshes the server-rendered editor so the new image row appears.
 */
export function ArtworkPhotoUpload({ artworkId }: { artworkId: string }) {
  const t = useTranslations("admin-catalog.photos");
  const router = useRouter();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) return;
    data.set("artworkId", artworkId);
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch(apiPaths.adminUploads("artwork"), {
        method: "POST",
        body: data,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setMessage({
          ok: false,
          text: t("uploadFailed", { code: body.error ?? String(res.status) }),
        });
        return;
      }
      form.reset();
      setMessage({ ok: true, text: t("uploaded") });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: t("uploadFailed", { code: "NETWORK" }) });
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-wrap items-end gap-3"
      data-testid="photo-upload"
    >
      <Field id={`${id}-file`} label={t("file")} hint={t("intro")}>
        {(c) => (
          <input
            {...c}
            type="file"
            name="file"
            accept="image/jpeg,image/png,image/webp"
            required
            className="min-h-11 text-sm"
          />
        )}
      </Field>
      <button
        type="submit"
        className={buttonClasses("secondary")}
        disabled={pending}
      >
        {pending ? t("uploading") : t("upload")}
      </button>
      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-sm" : "text-sm text-reddot"}
          data-testid="photo-upload-result"
        >
          {message.text}
        </p>
      ) : null}
    </form>
  );
}

/** "Use suggestion": fills the packed dimension fields of the surrounding form. */
export function UseSuggestionButton({
  label,
  values,
}: {
  label: string;
  values: Record<string, string>;
}) {
  return (
    <button
      type="button"
      className={buttonClasses("ghost", "sm")}
      onClick={(event) => {
        const form = event.currentTarget.form;
        if (!form) return;
        for (const [name, value] of Object.entries(values)) {
          const el = form.elements.namedItem(name);
          if (el instanceof HTMLInputElement) el.value = value;
        }
      }}
    >
      {label}
    </button>
  );
}
