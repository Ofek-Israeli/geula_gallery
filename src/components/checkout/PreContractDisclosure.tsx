import type { PreContractDoc } from "@/content/disclosure";

/**
 * Renders the pre-contract disclosure (spec §5.1 step 2) built by `content/disclosure.ts`. Shown
 * open on the checkout page so the buyer reads it before the consent checkboxes.
 */
export function PreContractDisclosure({ doc }: { doc: PreContractDoc }) {
  return (
    <section
      aria-labelledby="precontract-title"
      className="flex flex-col gap-4 rounded-sm border border-line bg-wall p-4 text-sm"
      data-testid="precontract"
    >
      <h2 id="precontract-title" className="text-xl">
        {doc.title}
      </h2>
      {doc.sections.map((s) => (
        <div key={`${s.id}:${s.heading}`} className="flex flex-col gap-1">
          <h3 className="font-sans font-semibold">{s.heading}</h3>
          {s.rows?.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              {s.rows.map((r) => (
                <div key={r.label} className="contents">
                  <dt className="text-ink-muted">{r.label}</dt>
                  <dd>
                    {r.value.startsWith("/") ? (
                      <a href={r.value} className="underline">
                        {r.label}
                      </a>
                    ) : (
                      <bdi>{r.value}</bdi>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {s.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      ))}
    </section>
  );
}
