import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `request-reply` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS4.
 */
export const requestReply = createStubTemplate<
  EmailTemplateProps["request-reply"]
>({
  id: "request-reply",
  audience: "buyer",
  reference: (p) => p.artworkTitle,
  recipientName: (p) => p.name,
});
