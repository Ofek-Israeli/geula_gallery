import { createStubTemplate } from "../stub";
import type { EmailTemplateProps } from "../types";

/**
 * `shipment-update` (spec §4.5). Rendered in the buyer's locale. M1 stub; owner: WS3.
 */
export const shipmentUpdate = createStubTemplate<
  EmailTemplateProps["shipment-update"]
>({
  id: "shipment-update",
  audience: "buyer",
  reference: (p) => p.orderNumber,
  recipientName: (p) => p.buyerName,
  orderUrl: (p) => p.orderUrl,
});
