import { Layout } from "../Layout";
import { Greeting, P, SignOff, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["request-ack"];

const subjectKey = (p: Props) =>
  `emails-requests.ack.subject${p.kind === "QUESTION" ? "Question" : p.kind === "QUOTE" ? "Quote" : "Offer"}`;

/**
 * `request-ack` (spec §4.5, §5.8): confirms a buyer question, quote request or offer was received,
 * in the buyer's locale, quoting their message back. Transactional only (no advertising).
 */
export const requestAck: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) => ctx.t(subjectKey(p), { title: p.artworkTitle ?? "" }),
  preview: (p, ctx) => ctx.t(subjectKey(p), { title: p.artworkTitle ?? "" }),
  Component: ({ props: p, ctx }) => {
    const t = (key: string, values?: Record<string, string | number>) =>
      ctx.t(`emails-requests.ack.${key}`, values);
    return (
      <Layout
        ctx={ctx}
        preview={ctx.t(subjectKey(p), { title: p.artworkTitle ?? "" })}
      >
        <Title>{t("title")}</Title>
        <Greeting ctx={ctx} name={p.name} />
        <P>
          {p.artworkTitle
            ? t(
                `body${p.kind === "QUESTION" ? "Question" : p.kind === "QUOTE" ? "Quote" : "Offer"}`,
                {
                  title: p.artworkTitle,
                },
              )
            : t("bodyGeneral")}
        </P>
        {p.message ? (
          <>
            <P muted>{t("yourMessage")}</P>
            <P>
              <span dir="auto" style={{ whiteSpace: "pre-wrap" }}>
                {p.message}
              </span>
            </P>
          </>
        ) : null}
        <P>{t("next")}</P>
        <SignOff ctx={ctx} />
      </Layout>
    );
  },
};
