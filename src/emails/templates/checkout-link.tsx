import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `checkout-link` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS2.
 */
export const checkoutLink = createStubTemplate<
  EmailTemplateProps["checkout-link"]
>({
  id: "checkout-link",
  audience: "buyer",
  reference: (p) => p.orderNumber,
  recipientName: (p) => p.buyerName,
  orderUrl: (p) => p.orderUrl,
});
