import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `order-confirmation` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: M2 first version, final by WS6.
 */
export const orderConfirmation = createStubTemplate<
  EmailTemplateProps["order-confirmation"]
>({
  id: "order-confirmation",
  audience: "buyer",
  reference: (p) => p.orderNumber,
  recipientName: (p) => p.buyerName,
  orderUrl: (p) => p.orderUrl,
});
