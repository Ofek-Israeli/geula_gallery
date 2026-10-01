import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `ready-for-pickup` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS3.
 */
export const readyForPickup = createStubTemplate<
  EmailTemplateProps["ready-for-pickup"]
>({
  id: "ready-for-pickup",
  audience: "buyer",
  reference: (p) => p.orderNumber,
  recipientName: (p) => p.buyerName,
  orderUrl: (p) => p.orderUrl,
});
