import { Layout } from "../Layout";
import { ButtonLink, Greeting, P, SignOff, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["receipt"];

/**
 * `receipt` (spec §4.3 step 5, §4.5): sent when the buyer consented to a receipt by email. Mock
 * documents say plainly that they are a demonstration, not a tax document.
 */
export const receipt: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    ctx.t(
      p.isDemoDocument
        ? "emails-commerce.receipt.subjectDemo"
        : "emails-commerce.receipt.subject",
      { number: p.orderNumber, doc: p.docNumber },
    ),
  preview: (p, ctx) =>
    ctx.t("emails-commerce.receipt.preview", { doc: p.docNumber }),
  Component: ({ props: p, ctx }) => (
    <Layout
      ctx={ctx}
      preview={ctx.t("emails-commerce.receipt.preview", { doc: p.docNumber })}
      orderUrl={p.orderUrl}
    >
      <Title>{ctx.t("emails-commerce.receipt.title")}</Title>
      <Greeting ctx={ctx} name={p.buyerName} />
      {p.isDemoDocument ? (
        <P>
          <strong>{ctx.t("emails-commerce.receipt.demoStamp")}</strong>
        </P>
      ) : null}
      <P>
        {ctx.t("emails-commerce.receipt.body", {
          doc: p.docNumber,
          number: p.orderNumber,
        })}
      </P>
      <ButtonLink href={p.docUrl}>
        {ctx.t("emails-commerce.receipt.view")}
      </ButtonLink>
      <SignOff ctx={ctx} />
    </Layout>
  ),
};
