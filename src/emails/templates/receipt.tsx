import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `receipt` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS2.
 */
export const receipt = createStubTemplate<EmailTemplateProps["receipt"]>({
  id: "receipt",
  audience: "buyer",
  reference: (p) => p.docNumber,
  recipientName: (p) => p.buyerName,
  orderUrl: (p) => p.orderUrl,
});
