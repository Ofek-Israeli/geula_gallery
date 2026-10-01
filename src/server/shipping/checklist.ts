import "server-only";
import type { PackagingType } from "./types";

/**
 * The packing checklist (spec §5.5 step 1). Pure. Items depend on the packaging types of the works
 * in the parcel; `required` items block "Confirm packed":
 * - the printed disclosure document in the parcel (s.14C(b); spec §1.2 "Required before packing");
 * - a printed receipt when the buyer did not consent to a receipt by email.
 * Everything else is guidance the painter ticks (and that the audit trail records).
 *
 * Packing photos (`purpose=packing` uploads) are required for international or insured parcels.
 */
export const CHECKLIST_ITEMS = [
  "noContactWithPaint",
  "cornerProtectors",
  "rigidSpacer",
  "tubeAtLeast10in",
  "rolledPaintOutward",
  "crateIspmExempt",
  "workCured",
  "coaSigned",
  "disclosureInserted",
  "receiptPrinted",
] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];

export interface ChecklistEntry {
  item: ChecklistItem;
  required: boolean;
}

export interface ChecklistContext {
  packagingTypes: readonly PackagingType[];
  /** Any work ships with a certificate of authenticity. */
  coaIncluded: boolean;
  /** `orders.receipt_email_consent`. */
  receiptEmailConsent: boolean;
}

export function checklistFor(c: ChecklistContext): ChecklistEntry[] {
  const types = new Set(c.packagingTypes);
  const items: ChecklistEntry[] = [
    { item: "noContactWithPaint", required: false },
  ];
  if (
    types.has("FLAT_BOX") ||
    types.has("STRETCHED_BOX") ||
    types.has("FRAMED_BOX")
  ) {
    items.push(
      { item: "cornerProtectors", required: false },
      { item: "rigidSpacer", required: false },
    );
  }
  if (types.has("ROLLED_TUBE")) {
    items.push(
      { item: "tubeAtLeast10in", required: false },
      { item: "rolledPaintOutward", required: false },
    );
  }
  if (types.has("CRATE"))
    items.push({ item: "crateIspmExempt", required: false });
  items.push({ item: "workCured", required: false });
  if (c.coaIncluded) items.push({ item: "coaSigned", required: false });
  items.push({ item: "disclosureInserted", required: true });
  if (!c.receiptEmailConsent) {
    items.push({ item: "receiptPrinted", required: true });
  }
  return items;
}

/** Required items that are not ticked. */
export function missingRequired(
  entries: readonly ChecklistEntry[],
  ticked: ReadonlySet<string>,
): ChecklistItem[] {
  return entries
    .filter((e) => e.required && !ticked.has(e.item))
    .map((e) => e.item);
}

/** Packing photos are required for international or insured parcels. */
export function photosRequired(i: {
  international: boolean;
  insured: boolean;
}): boolean {
  return i.international || i.insured;
}

/** Keys returned by `POST /api/admin/uploads?purpose=packing`. */
export const PACKING_PHOTO_KEY =
  /^packing\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;
export const MAX_PACKING_PHOTOS = 12;
