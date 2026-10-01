import type { CSSProperties } from "react";
import type { ArtworkCardDTO } from "@/lib/catalog";
import { ArtworkCard } from "./ArtworkCard";

/**
 * A pure-CSS justified grid (spec §6.3, minimal M2 version; WS1 polishes it): each item grows in
 * proportion to its aspect ratio (`flex: <aspect> 1 calc(<aspect> * var(--row-h))`), a trailing
 * spacer keeps the last row from stretching, and below 640 px there is one column.
 */
export function WorksGrid({
  works,
  priorityFirst = false,
  headingLevel = 2,
  label,
}: {
  works: ArtworkCardDTO[];
  priorityFirst?: boolean;
  headingLevel?: 2 | 3;
  label?: string;
}) {
  return (
    <ul
      aria-label={label}
      className="flex flex-wrap gap-x-6 gap-y-10 [--row-h:15rem] lg:[--row-h:18rem]"
    >
      {works.map((w, i) => {
        const aspect = w.image ? w.image.width / w.image.height : 1;
        return (
          <li
            key={w.id}
            style={{ "--a": aspect.toFixed(4) } as CSSProperties}
            className="min-w-0 [flex:var(--a)_1_calc(var(--a)*var(--row-h))] max-sm:basis-full"
          >
            <ArtworkCard
              artwork={w}
              priority={priorityFirst && i === 0}
              headingLevel={headingLevel}
            />
          </li>
        );
      })}
      <li aria-hidden="true" className="grow-[10] max-sm:hidden" />
    </ul>
  );
}
