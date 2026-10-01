import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `request-ack` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS4.
 */
export const requestAck = createStubTemplate<EmailTemplateProps["request-ack"]>(
  {
    id: "request-ack",
    audience: "buyer",
    reference: (p) => p.artworkTitle,
    recipientName: (p) => p.name,
  },
);
