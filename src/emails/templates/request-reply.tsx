import { Layout } from "../Layout";
import { Greeting, P, SignOff, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["request-reply"];

/** `request-reply` (spec §4.5, §5.8): the painter's reply to a buyer request, in the buyer's locale. */
export const requestReply: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    p.artworkTitle
      ? ctx.t("emails-requests.reply.subject", { title: p.artworkTitle })
      : ctx.t("emails-requests.reply.subjectGeneral"),
  preview: (p, ctx) =>
    p.artworkTitle
      ? ctx.t("emails-requests.reply.subject", { title: p.artworkTitle })
      : ctx.t("emails-requests.reply.subjectGeneral"),
  Component: ({ props: p, ctx }) => (
    <Layout
      ctx={ctx}
      preview={
        p.artworkTitle
          ? ctx.t("emails-requests.reply.subject", { title: p.artworkTitle })
          : ctx.t("emails-requests.reply.subjectGeneral")
      }
    >
      <Title>{ctx.t("emails-requests.reply.title")}</Title>
      <Greeting ctx={ctx} name={p.name} />
      <P>
        <span dir="auto" style={{ whiteSpace: "pre-wrap" }}>
          {p.reply}
        </span>
      </P>
      <P muted>{ctx.t("emails-requests.reply.replyHint")}</P>
      <SignOff ctx={ctx} />
    </Layout>
  ),
};
