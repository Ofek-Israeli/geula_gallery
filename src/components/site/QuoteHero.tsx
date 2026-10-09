import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { ArtworkCardDTO } from "@/lib/catalog";
import { paths } from "@/lib/routes";
import { PaintingBackdrop } from "./PaintingBackdrop";

/**
 * The home page's opening band: a painting as a dimmed full-width background with a quote about
 * painting on top (Georgia O'Keeffe), and a small caption that names and links the painting. The
 * band breaks out of the `<main>` container (`mx-[calc(50%-50vw)]`, direction-agnostic; `body`
 * clips the overflow) and sits flush under the header. It is the first window onto the painting
 * behind the page (`PaintingBackdrop`; the site footer is the second), and the painting is the
 * page's LCP image. It is decorative here (`alt=""`): the caption link names the work. The quote
 * marks are in the messages (Hebrew uses straight quotes, which follow the RTL run; English uses
 * curly ones).
 */
export function QuoteHero({ work }: { work: ArtworkCardDTO | null }) {
  const t = useTranslations("catalog.home");
  return (
    <section
      className="relative isolate -mt-8 mx-[calc(50%-50vw)] flex min-h-[26rem] items-center justify-center overflow-hidden bg-ink px-4 py-16 md:min-h-[34rem]"
      data-testid="home-hero"
    >
      {work?.image ? <PaintingBackdrop image={work.image} priority /> : null}
      <figure className="flex max-w-3xl flex-col items-center gap-5 text-center text-paper">
        <blockquote className="font-serif text-3xl leading-snug text-balance md:text-5xl">
          <p>{t("quote.text")}</p>
        </blockquote>
        <figcaption className="text-lg">— {t("quote.author")}</figcaption>
      </figure>
      {work ? (
        <p className="absolute bottom-3 inset-e-4 text-sm text-paper">
          <Link
            href={paths.artwork(work.slug)}
            className="inline-flex min-h-11 items-center underline"
            data-testid="home-hero-caption"
          >
            {t("heroCaption", { title: work.title })}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
