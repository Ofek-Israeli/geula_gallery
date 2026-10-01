import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `painter-cancellation` (spec §4.5). Always Hebrew (painter template). M1 stub; owner: WS6.
 */
export const painterCancellation = createStubTemplate<
  EmailTemplateProps["painter-cancellation"]
>({
  id: "painter-cancellation",
  audience: "painter",
  reference: (p) => p.cancellationNumber,
});
