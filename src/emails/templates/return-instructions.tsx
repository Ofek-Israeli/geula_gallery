import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `return-instructions` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS6.
 */
export const returnInstructions = createStubTemplate<
  EmailTemplateProps["return-instructions"]
>({
  id: "return-instructions",
  audience: "buyer",
  reference: (p) => p.cancellationNumber,
  recipientName: (p) => p.buyerName,
  orderUrl: (p) => p.orderUrl,
});
