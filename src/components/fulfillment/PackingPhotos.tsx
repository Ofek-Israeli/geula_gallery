"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

/**
 * Packing photos (spec §5.5 step 1): the camera / file picker uploads each image to
 * `POST /api/admin/uploads?purpose=packing` (private, rotated, metadata stripped, 2400 px) and keeps
 * only the returned keys, as hidden `photoKeys` inputs of the enclosing pack form (keys only,
 * never bytes, through the Server Action).
 */
export function PackingPhotos({
  uploadUrl,
  existing,
  required,
}: {
  uploadUrl: string;
  existing: { key: string; url: string }[];
  required: boolean;
}) {
  const t = useTranslations("shipping.fulfill.pack");
  const id = useId();
  const [keys, setKeys] = useState<string[]>(existing.map((p) => p.key));
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(files.length);
    const added: string[] = [];
    for (const file of Array.from(files)) {
      const body = new FormData();
      body.append("file", file);
      try {
        const res = await fetch(uploadUrl, { method: "POST", body });
        const json = (await res.json().catch(() => ({}))) as {
          fileKey?: string;
          error?: string;
        };
        if (res.ok && json.fileKey) added.push(json.fileKey);
        else setError(json.error ?? String(res.status));
      } catch {
        setError("NETWORK");
      }
    }
    setKeys((k) => [...k, ...added]);
    setUploading(0);
  }

  return (
    <fieldset className="flex flex-col gap-2" data-testid="packing-photos">
      <legend className="font-medium">
        {t("photos")}
        {required ? (
          <span className="ms-1 text-ink-muted">{t("required")}</span>
        ) : null}
      </legend>
      <p className="text-sm text-ink-muted">
        {required ? t("photosRequired") : t("photosOptional")}
      </p>
      <label htmlFor={id} className="text-sm">
        {t("choose")}
      </label>
      <input
        id={id}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        multiple
        onChange={(e) => upload(e.currentTarget.files)}
        data-testid="packing-photo-input"
      />
      {keys.map((key) => (
        <input key={key} type="hidden" name="photoKeys" value={key} />
      ))}
      {existing.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {existing.map((p, i) => (
            <li key={p.key}>
              <a href={p.url} target="_blank" rel="noreferrer">
                {/* biome-ignore lint/performance/noImgElement: signed private URL, not optimisable */}
                <img
                  src={p.url}
                  alt={t("photo", { n: i + 1 })}
                  className="size-20 object-cover"
                />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <p
        role="status"
        aria-live="polite"
        className="text-sm"
        data-testid="packing-photos-status"
      >
        {uploading > 0
          ? t("uploading", { n: uploading })
          : error
            ? t("uploadFailed", { code: error })
            : keys.length > 0
              ? t("uploaded", { count: keys.length })
              : null}
      </p>
    </fieldset>
  );
}
