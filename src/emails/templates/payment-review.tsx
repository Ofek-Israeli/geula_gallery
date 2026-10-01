import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `payment-review` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS2.
 */
export const paymentReview = createStubTemplate<
  EmailTemplateProps["payment-review"]
>({
  id: "payment-review",
  audience: "buyer",
  reference: (p) => p.orderNumber,
  recipientName: (p) => p.buyerName,
  orderUrl: (p) => p.orderUrl,
});
