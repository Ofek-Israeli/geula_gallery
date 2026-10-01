import "server-only";
import { randomInt } from "node:crypto";
import { CROCKFORD_ALPHABET } from "@/lib/validation/identifiers";

/**
 * Human-facing identifiers (spec §2.5, frozen contract):
 * - orders `GG-` + 6 Crockford base32 characters;
 * - cancellations `C-` + 6;
 * - artworks `A-YYYY-NNN` (a DB default; parsed here);
 * - commercial invoices `CI-<orderNumber>`;
 * - tax-document markers `<orderNumber>/<KIND>/<n>` (spec §3.3 tax_documents).
 *
 * Crockford base32 omits I, L, O and U, so numbers read aloud on the phone are unambiguous.
 * 32^6 ≈ 1.07e9 values; callers rely on the UNIQUE column and retry on a 23505.
 */
export {
  CANCELLATION_NUMBER_RE,
  CROCKFORD_ALPHABET,
  isCancellationNumber,
  isOrderNumber,
  normalizeCrockford,
  ORDER_NUMBER_RE,
  parseCancellationNumber,
  parseOrderNumber,
} from "@/lib/validation/identifiers";

const INVENTORY_RE = /^A-(\d{4})-(\d{3,})$/;

export function randomCrockford(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CROCKFORD_ALPHABET[randomInt(32)];
  return out;
}

export function newOrderNumber(): string {
  return `GG-${randomCrockford(6)}`;
}

export function newCancellationNumber(): string {
  return `C-${randomCrockford(6)}`;
}

export function parseInventoryNumber(
  value: string,
): { year: number; seq: number } | null {
  const m = INVENTORY_RE.exec(value);
  if (!m?.[1] || !m[2]) return null;
  return { year: Number(m[1]), seq: Number(m[2]) };
}

export function commercialInvoiceNumber(orderNumber: string): string {
  return `CI-${orderNumber}`;
}

export type TaxDocumentMarkerKind =
  | "RECEIPT"
  | "INVOICE_RECEIPT"
  | "CREDIT_NOTE";

/** `GG-7K3M9Q/RECEIPT/1`: searched for in Morning's `description` to keep issuance exactly-once. */
export function taxDocumentMarker(
  orderNumber: string,
  kind: TaxDocumentMarkerKind,
  n: number,
): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be >= 1");
  return `${orderNumber}/${kind}/${n}`;
}

/** PayPal `invoice_id` per attempt (`<orderNumber>-<seq>`) and per refund (`<orderNumber>-R<n>`). */
export function attemptInvoiceId(orderNumber: string, seq: number): string {
  return `${orderNumber}-${seq}`;
}

export function refundInvoiceId(orderNumber: string, n: number): string {
  return `${orderNumber}-R${n}`;
}
