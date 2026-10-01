/**
 * Email template registry (spec §4.5, §9.4: created in M1 with stub files; each stream replaces
 * the body of its own template file and never edits this map).
 */
import { adminAlert } from "./templates/admin-alert";
import { cancellationAck } from "./templates/cancellation-ack";
import { checkoutLink } from "./templates/checkout-link";
import { orderConfirmation } from "./templates/order-confirmation";
import { painterCancellation } from "./templates/painter-cancellation";
import { painterNewOrder } from "./templates/painter-new-order";
import { painterNewRequest } from "./templates/painter-new-request";
import { paymentReview } from "./templates/payment-review";
import { purchaseNotCompleted } from "./templates/purchase-not-completed";
import { readyForPickup } from "./templates/ready-for-pickup";
import { receipt } from "./templates/receipt";
import { refundIssued } from "./templates/refund-issued";
import { requestAck } from "./templates/request-ack";
import { requestReply } from "./templates/request-reply";
import { returnInstructions } from "./templates/return-instructions";
import { shipmentUpdate } from "./templates/shipment-update";
import type { EmailTemplateRegistry } from "./types";

export * from "./types";

export const EMAIL_TEMPLATES: EmailTemplateRegistry = {
  "order-confirmation": orderConfirmation,
  "payment-review": paymentReview,
  "purchase-not-completed": purchaseNotCompleted,
  "shipment-update": shipmentUpdate,
  "ready-for-pickup": readyForPickup,
  receipt: receipt,
  "checkout-link": checkoutLink,
  "request-ack": requestAck,
  "request-reply": requestReply,
  "cancellation-ack": cancellationAck,
  "return-instructions": returnInstructions,
  "refund-issued": refundIssued,
  "painter-new-order": painterNewOrder,
  "painter-new-request": painterNewRequest,
  "painter-cancellation": painterCancellation,
  "admin-alert": adminAlert,
};
