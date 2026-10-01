import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `painter-new-order` (spec §4.5). Always Hebrew (painter template). M1 stub; owner: M2 (commerce lead).
 */
export const painterNewOrder = createStubTemplate<
  EmailTemplateProps["painter-new-order"]
>({
  id: "painter-new-order",
  audience: "painter",
  reference: (p) => p.orderNumber,
});
