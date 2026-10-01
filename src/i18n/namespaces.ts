/**
 * Message namespaces (spec §9.4). Every namespace is one JSON file per locale in
 * `messages/{he,en}/<namespace>.json`, merged here into one messages object keyed by namespace.
 *
 * - Frozen after M1: this file already lists every namespace. Each file has exactly one owner
 *   (see NAMESPACE_OWNERS); a stream edits only its own files.
 * - Pure (no next-intl, no server-only): used by `src/i18n/request.ts` and by
 *   `src/server/i18n.ts` (use-intl/core) for emails and documents rendered outside Next.
 * - The `en` object must have the same shape as `he` (checked at typecheck time below).
 */

import enAdminCatalog from "../../messages/en/admin-catalog.json";
import enAdminOrders from "../../messages/en/admin-orders.json";
import enAdminSettings from "../../messages/en/admin-settings.json";
import enAdminShell from "../../messages/en/admin-shell.json";
import enArtwork from "../../messages/en/artwork.json";
import enCancel from "../../messages/en/cancel.json";
import enCatalog from "../../messages/en/catalog.json";
import enCheckout from "../../messages/en/checkout.json";
import enCommon from "../../messages/en/common.json";
import enDocumentsCompliance from "../../messages/en/documents-compliance.json";
import enDocumentsShipping from "../../messages/en/documents-shipping.json";
import enEmailsCommerce from "../../messages/en/emails-commerce.json";
import enEmailsCompliance from "../../messages/en/emails-compliance.json";
import enEmailsCore from "../../messages/en/emails-core.json";
import enEmailsRequests from "../../messages/en/emails-requests.json";
import enEmailsShipping from "../../messages/en/emails-shipping.json";
import enLegal from "../../messages/en/legal.json";
import enOrders from "../../messages/en/orders.json";
import enRequests from "../../messages/en/requests.json";
import enShipping from "../../messages/en/shipping.json";
import heAdminCatalog from "../../messages/he/admin-catalog.json";
import heAdminOrders from "../../messages/he/admin-orders.json";
import heAdminSettings from "../../messages/he/admin-settings.json";
import heAdminShell from "../../messages/he/admin-shell.json";
import heArtwork from "../../messages/he/artwork.json";
import heCancel from "../../messages/he/cancel.json";
import heCatalog from "../../messages/he/catalog.json";
import heCheckout from "../../messages/he/checkout.json";
import heCommon from "../../messages/he/common.json";
import heDocumentsCompliance from "../../messages/he/documents-compliance.json";
import heDocumentsShipping from "../../messages/he/documents-shipping.json";
import heEmailsCommerce from "../../messages/he/emails-commerce.json";
import heEmailsCompliance from "../../messages/he/emails-compliance.json";
import heEmailsCore from "../../messages/he/emails-core.json";
import heEmailsRequests from "../../messages/he/emails-requests.json";
import heEmailsShipping from "../../messages/he/emails-shipping.json";
import heLegal from "../../messages/he/legal.json";
import heOrders from "../../messages/he/orders.json";
import heRequests from "../../messages/he/requests.json";
import heShipping from "../../messages/he/shipping.json";
import type { AppLocale } from "./routing";

export const NAMESPACES = [
  "common",
  "emails-core",
  "catalog",
  "artwork",
  "checkout",
  "orders",
  "emails-commerce",
  "shipping",
  "emails-shipping",
  "documents-shipping",
  "requests",
  "emails-requests",
  "admin-shell",
  "admin-catalog",
  "admin-orders",
  "admin-settings",
  "cancel",
  "legal",
  "emails-compliance",
  "documents-compliance",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/** Owner of each namespace file (spec §9.4). */
export const NAMESPACE_OWNERS: Record<
  Namespace,
  "M1" | "WS1" | "WS2" | "WS3" | "WS4" | "WS6"
> = {
  common: "M1",
  "emails-core": "M1",
  catalog: "WS1",
  artwork: "WS1",
  checkout: "WS2",
  orders: "WS2",
  "emails-commerce": "WS2",
  shipping: "WS3",
  "emails-shipping": "WS3",
  "documents-shipping": "WS3",
  requests: "WS4",
  "emails-requests": "WS4",
  "admin-shell": "WS4",
  "admin-catalog": "WS4",
  "admin-orders": "WS4",
  "admin-settings": "WS4",
  cancel: "WS6",
  legal: "WS6",
  "emails-compliance": "WS6",
  "documents-compliance": "WS6",
};

const he = {
  common: heCommon,
  "emails-core": heEmailsCore,
  catalog: heCatalog,
  artwork: heArtwork,
  checkout: heCheckout,
  orders: heOrders,
  "emails-commerce": heEmailsCommerce,
  shipping: heShipping,
  "emails-shipping": heEmailsShipping,
  "documents-shipping": heDocumentsShipping,
  requests: heRequests,
  "emails-requests": heEmailsRequests,
  "admin-shell": heAdminShell,
  "admin-catalog": heAdminCatalog,
  "admin-orders": heAdminOrders,
  "admin-settings": heAdminSettings,
  cancel: heCancel,
  legal: heLegal,
  "emails-compliance": heEmailsCompliance,
  "documents-compliance": heDocumentsCompliance,
};

/** The message shape. Hebrew is the source of truth. */
export type Messages = typeof he;

// Typecheck-time parity: English must provide every Hebrew key (extra keys are allowed but unused).
const en: Messages = {
  common: enCommon,
  "emails-core": enEmailsCore,
  catalog: enCatalog,
  artwork: enArtwork,
  checkout: enCheckout,
  orders: enOrders,
  "emails-commerce": enEmailsCommerce,
  shipping: enShipping,
  "emails-shipping": enEmailsShipping,
  "documents-shipping": enDocumentsShipping,
  requests: enRequests,
  "emails-requests": enEmailsRequests,
  "admin-shell": enAdminShell,
  "admin-catalog": enAdminCatalog,
  "admin-orders": enAdminOrders,
  "admin-settings": enAdminSettings,
  cancel: enCancel,
  legal: enLegal,
  "emails-compliance": enEmailsCompliance,
  "documents-compliance": enDocumentsCompliance,
};

const MESSAGES: Record<AppLocale, Messages> = { he, en };

export function getMessagesFor(locale: AppLocale): Messages {
  return MESSAGES[locale];
}
