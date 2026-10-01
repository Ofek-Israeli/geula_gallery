import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `painter-new-request` (spec §4.5). Always Hebrew (painter template). M1 stub; owner: WS4.
 */
export const painterNewRequest = createStubTemplate<
  EmailTemplateProps["painter-new-request"]
>({
  id: "painter-new-request",
  audience: "painter",
  reference: (p) => p.artworkTitle,
});
