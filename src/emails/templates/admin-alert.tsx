import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `admin-alert` (spec §4.5). Always Hebrew (painter template). M1 stub; owner: WS6.
 */
export const adminAlert = createStubTemplate<EmailTemplateProps["admin-alert"]>(
  {
    id: "admin-alert",
    audience: "painter",
    reference: (p) => p.kind,
  },
);
