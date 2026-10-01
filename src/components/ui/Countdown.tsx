"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Bdi } from "./Bdi";
import { VisuallyHidden } from "./VisuallyHidden";

function remainingMs(until: string): number {
  return Math.max(0, new Date(until).getTime() - Date.now());
}

/**
 * Hold countdown (spec §5.1 order page). Display only: the server decides expiry. The visible
 * timer ticks every second; the live region announces once per minute to avoid chatter.
 */
export function Countdown({
  until,
  className,
}: {
  /** ISO timestamp. */
  until: string;
  className?: string;
}) {
  const t = useTranslations("common.countdown");
  const [ms, setMs] = useState<number | null>(null);

  useEffect(() => {
    setMs(remainingMs(until));
    const timer = setInterval(() => setMs(remainingMs(until)), 1000);
    return () => clearInterval(timer);
  }, [until]);

  if (ms === null) return <span className={className} />;
  if (ms === 0) {
    return (
      <span className={className} role="status">
        {t("expired")}
      </span>
    );
  }
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60));
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return (
    <span className={className}>
      <span aria-hidden="true">
        <Bdi>
          {minutes}:{seconds}
        </Bdi>
      </span>
      <VisuallyHidden>
        <span role="status">
          {t("label")}: {t("remaining", { minutes, seconds: "00" })}
        </span>
      </VisuallyHidden>
    </span>
  );
}
