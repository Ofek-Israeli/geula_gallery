import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `purchase-not-completed` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS2.
 */
export const purchaseNotCompleted = createStubTemplate<
  EmailTemplateProps["purchase-not-completed"]
>({
  id: "purchase-not-completed",
  audience: "buyer",
  reference: (p) => p.orderNumber,
  recipientName: (p) => p.buyerName,
  orderUrl: (p) => p.orderUrl,
});
