import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `refund-issued` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS2.
 */
export const refundIssued = createStubTemplate<
  EmailTemplateProps["refund-issued"]
>({
  id: "refund-issued",
  audience: "buyer",
  reference: (p) => p.orderNumber,
  recipientName: (p) => p.buyerName,
  orderUrl: (p) => p.orderUrl,
});
