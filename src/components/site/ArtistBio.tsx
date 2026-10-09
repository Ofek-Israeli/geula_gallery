import { useTranslations } from "next-intl";
import { cx } from "@/lib/cx";

/** The paragraphs of `catalog.bio` (the painter's text; Hebrew verbatim, English translated). */
const PARAGRAPHS = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;

/**
 * The artist's biography, shared by the home page (as its `<h1>`, in a centred reading column) and
 * `/about` (an `<h2>` under the page title, aligned with it). Paragraphs stay start-aligned. Lives
 * in messages until a `site_content` editor exists.
 */
export function ArtistBio({
  headingLevel = 2,
  centred = false,
  id = "artist-bio",
}: {
  headingLevel?: 1 | 2;
  centred?: boolean;
  id?: string;
}) {
  const t = useTranslations("catalog.bio");
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section
      aria-labelledby={id}
      className={cx(
        "flex w-full max-w-prose flex-col gap-5",
        centred && "mx-auto",
      )}
      data-testid="artist-bio"
    >
      <Heading
        id={id}
        className={headingLevel === 1 ? "text-4xl md:text-5xl" : "text-3xl"}
      >
        {t("title")}
      </Heading>
      {PARAGRAPHS.map((p) => (
        <p key={p} className="text-lg">
          {t(p)}
        </p>
      ))}
    </section>
  );
}
