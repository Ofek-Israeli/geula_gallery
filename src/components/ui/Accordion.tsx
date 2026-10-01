import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

/** Disclosure built on `<details>`/`<summary>`: keyboard and screen-reader support for free. */
export function Accordion({
  summary,
  children,
  defaultOpen,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details
      open={defaultOpen}
      className={cx("group border-b border-line", className)}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-3 font-medium">
        <span>{summary}</span>
        <span
          aria-hidden="true"
          className="transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="pbe-4">{children}</div>
    </details>
  );
}
