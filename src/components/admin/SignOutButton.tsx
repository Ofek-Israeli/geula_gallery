"use client";

import { useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { getAuthClient } from "@/lib/auth-client";
import type { Locale } from "@/lib/locale";

export function SignOutButton({
  locale,
  label,
}: {
  locale: Locale;
  label: string;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={buttonClasses("ghost", "sm")}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await getAuthClient().signOut();
        window.location.assign(`/${locale}/admin/login`);
      }}
    >
      {label}
    </button>
  );
}
