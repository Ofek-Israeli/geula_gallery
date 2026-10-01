import type { DocSection } from "@/content/disclosure";

/**
 * Renders the sections of a document built by `content/disclosure.ts` (pre-contract disclosure or
 * the s.14C(b) disclosure document) for print. Values are isolated with `<bdi>` so numbers, emails
 * and Latin names keep their direction inside Hebrew text.
 */
export function DocumentSections({ sections }: { sections: DocSection[] }) {
  return (
    <div className="flex flex-col gap-5">
      {sections.map((s) => (
        <section
          key={`${s.id}:${s.heading}`}
          className="flex flex-col gap-1 break-inside-avoid"
        >
          <h2 className="font-sans text-lg font-semibold">{s.heading}</h2>
          {s.rows?.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              {s.rows.map((r) => (
                <div key={`${r.label}:${r.value}`} className="contents">
                  <dt className="text-ink-muted">{r.label}</dt>
                  <dd>
                    <bdi>{r.value}</bdi>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {s.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </section>
      ))}
    </div>
  );
}
