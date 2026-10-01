"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { fromJerusalemWallClock } from "@/lib/format";
import { CURRENCIES } from "@/lib/money";
import {
  checkboxSchema,
  requiredText,
  slugSchema,
  uuidSchema,
} from "@/lib/validation/common";
import {
  ARTWORK_MEDIUMS,
  ARTWORK_SURFACES,
  createArtwork,
  deleteArtworkImage,
  deleteDraftArtwork,
  HOLD_REASONS,
  IMAGE_ROLES,
  markDamaged,
  markForSale,
  markNotForSale,
  markSoldOffline,
  moveArtworkImage,
  PACKAGING_TYPES,
  releaseOfflineHold,
  relistArtwork,
  setOfflineHold,
  updateArtworkCustoms,
  updateArtworkDetails,
  updateArtworkImage,
  updateArtworkPrice,
  updateArtworkShipping,
  updateArtworkSize,
} from "@/server/catalog/mutations";
import { publishArtwork, unpublishArtwork } from "@/server/catalog/publish";
import { adminAction } from "@/server/next/actions";
import {
  cmToMmSchema,
  domainErrors,
  intSchema,
  nullableText,
  optionalAmountMinorSchema,
  optionalCmToMmSchema,
  optionalIntSchema,
  optionalKgToGSchema,
} from "../_shared/action-errors";

/**
 * Artwork admin actions (spec §6.10 editor, §5.9 offline hold / sale / relist). Every export is
 * wrapped by `adminAction` (session, 2FA, locale, zod). Sale-state changes and price changes ask
 * for a fresh session (money).
 */
const id = z.object({ artworkId: uuidSchema });

/** Noon in Jerusalem on a `YYYY-MM-DD` day (the calendar date is what matters). */
function jerusalemNoon(day: string): Date {
  const [year = 0, month = 0, date = 0] = day.split("-").map(Number);
  return fromJerusalemWallClock({
    year,
    month,
    day: date,
    hour: 12,
    minute: 0,
    second: 0,
  });
}

export const createArtworkAction = adminAction(
  z.object({
    titleHe: requiredText(200),
    titleEn: requiredText(200),
    slug: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      slugSchema.optional(),
    ),
    medium: z.enum(ARTWORK_MEDIUMS),
    surface: z.enum(ARTWORK_SURFACES),
    heightCm: cmToMmSchema,
    widthCm: cmToMmSchema,
    depthCm: optionalCmToMmSchema,
  }),
  async (input, ctx) => {
    const out = await domainErrors(() =>
      createArtwork(ctx, {
        titleHe: input.titleHe,
        titleEn: input.titleEn,
        slug: input.slug,
        medium: input.medium,
        surface: input.surface,
        heightMm: input.heightCm,
        widthMm: input.widthCm,
        depthMm: input.depthCm,
      }),
    );
    redirect(`/${ctx.locale}/admin/artworks/${out.result.id}?created=1`);
  },
  { name: "artworks.create" },
);

export const updateDetailsAction = adminAction(
  id.extend({
    titleHe: requiredText(200),
    titleEn: requiredText(200),
    slug: slugSchema,
    descriptionHe: z.string().trim().max(5000).default(""),
    descriptionEn: z.string().trim().max(5000).default(""),
    yearCreated: optionalIntSchema(1800, 2100),
    medium: z.enum(ARTWORK_MEDIUMS),
    surface: z.enum(ARTWORK_SURFACES),
    mediumDetailHe: nullableText(200),
    mediumDetailEn: nullableText(200),
    seriesId: z.preprocess(
      (v) => (v === "" ? null : v),
      uuidSchema.nullable().default(null),
    ),
    featured: checkboxSchema,
    sortOrder: intSchema(-10_000, 10_000, 0),
  }),
  async ({ artworkId, ...input }, ctx) =>
    domainErrors(() => updateArtworkDetails(ctx, artworkId, input)),
  { name: "artworks.details" },
);

export const updateSizeAction = adminAction(
  id.extend({
    heightCm: cmToMmSchema,
    widthCm: cmToMmSchema,
    depthCm: optionalCmToMmSchema,
    framed: checkboxSchema,
    frameHeightCm: optionalCmToMmSchema,
    frameWidthCm: optionalCmToMmSchema,
    frameDepthCm: optionalCmToMmSchema,
    glazing: z.enum(["NONE", "GLASS", "ACRYLIC"]),
    readyToHang: checkboxSchema,
    signed: checkboxSchema,
    paintedEdges: checkboxSchema,
    coaIncluded: checkboxSchema,
  }),
  async (i, ctx) =>
    domainErrors(() =>
      updateArtworkSize(ctx, i.artworkId, {
        heightMm: i.heightCm,
        widthMm: i.widthCm,
        depthMm: i.depthCm,
        framed: i.framed,
        frameHeightMm: i.frameHeightCm,
        frameWidthMm: i.frameWidthCm,
        frameDepthMm: i.frameDepthCm,
        glazing: i.glazing,
        readyToHang: i.readyToHang,
        signed: i.signed,
        paintedEdges: i.paintedEdges,
        coaIncluded: i.coaIncluded,
      }),
    ),
  { name: "artworks.size" },
);

export const updatePriceAction = adminAction(
  id.extend({
    priceIls: optionalAmountMinorSchema,
    priceUsd: optionalAmountMinorSchema,
    priceOnRequest: checkboxSchema,
    offersEnabled: checkboxSchema,
    offerAutoDeclineBelowIls: optionalAmountMinorSchema,
    confirmPriceChange: checkboxSchema,
  }),
  async (i, ctx) =>
    domainErrors(() =>
      updateArtworkPrice(ctx, i.artworkId, {
        priceIlsMinor: i.priceIls,
        priceUsdMinor: i.priceUsd,
        priceOnRequest: i.priceOnRequest,
        offersEnabled: i.offersEnabled,
        offerAutoDeclineBelowIlsMinor: i.offerAutoDeclineBelowIls,
        confirmPriceChange: i.confirmPriceChange,
      }),
    ),
  { name: "artworks.price", fresh: true },
);

export const updateShippingAction = adminAction(
  id.extend({
    packagingType: z.enum(PACKAGING_TYPES),
    canBeRolled: checkboxSchema,
    packedLengthCm: optionalCmToMmSchema,
    packedWidthCm: optionalCmToMmSchema,
    packedHeightCm: optionalCmToMmSchema,
    packedWeightKg: optionalKgToGSchema,
    sizeClassOverride: z.preprocess(
      (v) => (v === "" ? null : v),
      z.enum(["S", "M", "L", "QUOTE"]).nullable().default(null),
    ),
    shipsInternationally: checkboxSchema,
    localPickupOnly: checkboxSchema,
    quoteOnly: checkboxSchema,
    dispatchDays: intSchema(0, 60, 5),
  }),
  async (i, ctx) =>
    domainErrors(() =>
      updateArtworkShipping(ctx, i.artworkId, {
        packagingType: i.packagingType,
        canBeRolled: i.canBeRolled,
        packedLengthMm: i.packedLengthCm,
        packedWidthMm: i.packedWidthCm,
        packedHeightMm: i.packedHeightCm,
        packedWeightG: i.packedWeightKg,
        sizeClassOverride: i.sizeClassOverride,
        shipsInternationally: i.shipsInternationally,
        localPickupOnly: i.localPickupOnly,
        quoteOnly: i.quoteOnly,
        dispatchDays: i.dispatchDays,
      }),
    ),
  { name: "artworks.shipping" },
);

export const updateCustomsAction = adminAction(
  id.extend({
    hsCode: z
      .string()
      .trim()
      .regex(/^\d{4}(\.\d{2}){0,2}$/),
    customsDescriptionEn: nullableText(300),
    countryOfOrigin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/),
    declaredValueOverrideIls: optionalAmountMinorSchema,
    maxInsurableValueIls: optionalAmountMinorSchema,
    creditLine: nullableText(300),
  }),
  async (i, ctx) =>
    domainErrors(() =>
      updateArtworkCustoms(ctx, i.artworkId, {
        hsCode: i.hsCode,
        customsDescriptionEn: i.customsDescriptionEn,
        countryOfOrigin: i.countryOfOrigin,
        declaredValueOverrideMinor: i.declaredValueOverrideIls,
        maxInsurableValueMinor: i.maxInsurableValueIls,
        creditLine: i.creditLine,
      }),
    ),
  { name: "artworks.customs" },
);

export const publishAction = adminAction(
  id,
  async (i, ctx) => domainErrors(() => publishArtwork(ctx, i.artworkId)),
  { name: "artworks.publish" },
);

export const unpublishAction = adminAction(
  id,
  async (i, ctx) => domainErrors(() => unpublishArtwork(ctx, i.artworkId)),
  { name: "artworks.unpublish" },
);

export const deleteDraftAction = adminAction(
  id,
  async (i, ctx) => {
    await domainErrors(() => deleteDraftArtwork(ctx, i.artworkId));
    redirect(`/${ctx.locale}/admin/artworks?deleted=1`);
  },
  { name: "artworks.delete" },
);

// ---------------------------------------------------------------- images

const imageId = z.object({ imageId: uuidSchema });

export const updateImageAction = adminAction(
  imageId.extend({
    role: z.enum(IMAGE_ROLES),
    altHe: z.string().trim().max(500).default(""),
    altEn: z.string().trim().max(500).default(""),
    creditLine: nullableText(300),
  }),
  async ({ imageId, ...input }, ctx) =>
    domainErrors(() => updateArtworkImage(ctx, imageId, input)),
  { name: "artworks.image" },
);

export const moveImageAction = adminAction(
  imageId.extend({ direction: z.enum(["up", "down"]) }),
  async (i, ctx) =>
    domainErrors(() => moveArtworkImage(ctx, i.imageId, i.direction)),
  { name: "artworks.image_move" },
);

export const deleteImageAction = adminAction(
  imageId,
  async (i, ctx) => domainErrors(() => deleteArtworkImage(ctx, i.imageId)),
  { name: "artworks.image_delete" },
);

// ---------------------------------------------------------------- sale state (spec §5.9)

const override = { confirmOverride: checkboxSchema };

export const offlineHoldAction = adminAction(
  id.extend({
    reason: z.enum(HOLD_REASONS),
    note: nullableText(500),
    ...override,
  }),
  async (i, ctx) =>
    domainErrors(() =>
      setOfflineHold(ctx, i.artworkId, {
        reason: i.reason,
        note: i.note,
        confirmOverride: i.confirmOverride,
      }),
    ),
  { name: "artworks.offline_hold", fresh: true },
);

export const releaseHoldAction = adminAction(
  id,
  async (i, ctx) => domainErrors(() => releaseOfflineHold(ctx, i.artworkId)),
  { name: "artworks.release_hold", fresh: true },
);

export const soldOfflineAction = adminAction(
  id.extend({
    soldOn: z.iso.date(),
    price: optionalAmountMinorSchema,
    currency: z.enum(CURRENCIES).default("ILS"),
    note: nullableText(500),
    ...override,
  }),
  async (i, ctx) =>
    domainErrors(() =>
      markSoldOffline(ctx, i.artworkId, {
        soldAt: jerusalemNoon(i.soldOn),
        priceMinor: i.price,
        currency: i.currency,
        note: i.note,
        confirmOverride: i.confirmOverride,
      }),
    ),
  { name: "artworks.sold_offline", fresh: true },
);

export const relistAction = adminAction(
  id.extend({ confirm: checkboxSchema, reason: nullableText(500) }),
  async (i, ctx) =>
    domainErrors(() =>
      relistArtwork(ctx, i.artworkId, {
        confirm: i.confirm,
        reason: i.reason,
      }),
    ),
  { name: "artworks.relist", fresh: true },
);

export const damagedAction = adminAction(
  id.extend({ confirm: checkboxSchema, reason: nullableText(500) }),
  async (i, ctx) =>
    domainErrors(() =>
      markDamaged(ctx, i.artworkId, { confirm: i.confirm, reason: i.reason }),
    ),
  { name: "artworks.damaged", fresh: true },
);

export const notForSaleAction = adminAction(
  id.extend(override),
  async (i, ctx) =>
    domainErrors(() =>
      markNotForSale(ctx, i.artworkId, { confirmOverride: i.confirmOverride }),
    ),
  { name: "artworks.not_for_sale", fresh: true },
);

export const forSaleAction = adminAction(
  id,
  async (i, ctx) => domainErrors(() => markForSale(ctx, i.artworkId)),
  { name: "artworks.for_sale", fresh: true },
);
