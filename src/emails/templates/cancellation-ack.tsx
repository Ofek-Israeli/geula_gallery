import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `cancellation-ack` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS6.
 */
export const cancellationAck = createStubTemplate<
  EmailTemplateProps["cancellation-ack"]
>({
  id: "cancellation-ack",
  audience: "buyer",
  reference: (p) => p.cancellationNumber,
  recipientName: (p) => p.fullName,
});
