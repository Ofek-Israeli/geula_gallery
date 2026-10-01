import { Layout } from "../Layout";
import { Greeting, P, SignOff, Subtitle, Title } from "../parts";
import type { EmailTemplate, EmailTemplateProps } from "../types";

type Props = EmailTemplateProps["ready-for-pickup"];

/**
 * `ready-for-pickup` (spec §4.5, §5.5 step 3c): the work is ready at the studio. This email is
 * where the pickup address is revealed (it is not shown before payment). The printed disclosure
 * is handed over at pickup.
 */
export const readyForPickup: EmailTemplate<Props> = {
  audience: "buyer",
  subject: (p, ctx) =>
    ctx.t("emails-shipping.pickup.subject", { number: p.orderNumber }),
  preview: (_p, ctx) => ctx.t("emails-shipping.pickup.title"),
  Component: ({ props: p, ctx }) => (
    <Layout
      ctx={ctx}
      preview={ctx.t("emails-shipping.pickup.title")}
      orderUrl={p.orderUrl}
    >
      <Title>{ctx.t("emails-shipping.pickup.title")}</Title>
      <Greeting ctx={ctx} name={p.buyerName} />
      <P>{ctx.t("emails-shipping.pickup.body", { number: p.orderNumber })}</P>
      <Subtitle>{ctx.t("emails-shipping.pickup.address")}</Subtitle>
      <P>
        <span data-pickup-address="">{p.pickupAddress}</span>
      </P>
      {p.pickupInstructions ? (
        <>
          <Subtitle>{ctx.t("emails-shipping.pickup.instructions")}</Subtitle>
          <P>{p.pickupInstructions}</P>
        </>
      ) : null}
      <P>{ctx.t("emails-shipping.pickup.schedule")}</P>
      <P muted>{ctx.t("emails-shipping.pickup.disclosure")}</P>
      <SignOff ctx={ctx} />
    </Layout>
  ),
};
