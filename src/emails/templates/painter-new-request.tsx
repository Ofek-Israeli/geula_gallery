import { Layout } from "../Layout";
import { ButtonLink, money, P, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["painter-new-request"];

const kindKey = (p: Props) =>
  p.kind === "QUESTION" ? "question" : p.kind === "QUOTE" ? "quote" : "offer";

/**
 * `painter-new-request` (spec §4.5, §5.8): a new buyer question, quote request or offer, with a
 * link to the admin inbox. Always Hebrew (painter template).
 */
export const painterNewRequest: EmailTemplate<Props> = {
  audience: "painter",
  subject: (p, ctx) =>
    ctx.t(`emails-requests.painter.subject.${kindKey(p)}`, {
      name: p.name,
      title: p.artworkTitle ?? "",
    }),
  preview: (p, ctx) =>
    ctx.t(`emails-requests.painter.subject.${kindKey(p)}`, {
      name: p.name,
      title: p.artworkTitle ?? "",
    }),
  Component: ({ props: p, ctx }) => {
    const t = (key: string, values?: Record<string, string | number>) =>
      ctx.t(`emails-requests.painter.${key}`, values);
    return (
      <Layout
        ctx={ctx}
        preview={t(`subject.${kindKey(p)}`, {
          name: p.name,
          title: p.artworkTitle ?? "",
        })}
      >
        <Title>{t(`title.${kindKey(p)}`)}</Title>
        {p.artworkTitle ? (
          <P>{t("artwork", { title: p.artworkTitle })}</P>
        ) : null}
        <P>
          {t("from", { name: p.name })} · <span dir="ltr">{p.email}</span>
          {p.country ? ` · ${p.country}` : ""}
        </P>
        {p.offerAmountMinor && p.offerCurrency ? (
          <P>
            {t("offer")}{" "}
            <span dir="ltr">
              {money(ctx, p.offerAmountMinor, p.offerCurrency)}
            </span>
          </P>
        ) : null}
        {p.message ? (
          <P>
            <span dir="auto" style={{ whiteSpace: "pre-wrap" }}>
              {p.message}
            </span>
          </P>
        ) : null}
        <ButtonLink href={p.adminRequestUrl}>{t("open")}</ButtonLink>
      </Layout>
    );
  },
};
