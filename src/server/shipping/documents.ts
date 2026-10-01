import "server-only";
import { asc, eq } from "drizzle-orm";
import { isEuCountry } from "@/lib/countries";
import type { Locale } from "@/lib/locale";
import type { Currency } from "@/lib/money";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import {
  artworks,
  orderItems,
  orders,
  type Shipment,
  shipments,
} from "@/server/db/schema";
import type { AdminContext } from "@/server/domain/admin";
import { commercialInvoiceNumber } from "@/server/domain/ids";
import { getSetting } from "@/server/settings";
import {
  customsDescriptionEn,
  EU_CULTURAL_GOODS_STATEMENT,
  EXPORT_COMMODITY_CODE,
  HS_CODE,
  importCommodityCode,
  ORIGIN_STATEMENT,
} from "./customs";
import type { ShipmentPackage } from "./types";

/**
 * Data for the admin printables (spec §5.4 "Printables"): the packing slip (in the admin's locale)
 * and the commercial invoice (English; the full §4.4 customs content and a signature line). Admin
 * only: both carry the buyer's address. The exporter block may show the business ID / VAT number
 * (documents are noindex; spec §1.2 "Seller identity").
 */
export interface PrintParty {
  name: string;
  company?: string;
  lines: string[];
  phone?: string;
  email?: string;
}

export interface PackingSlipData {
  orderNumber: string;
  createdAt: Date;
  from: PrintParty;
  to: PrintParty;
  method: string;
  carrierName: string | null;
  trackingNumber: string | null;
  items: {
    title: string;
    inventoryNumber: string;
    heightMm: number;
    widthMm: number;
    depthMm: number | null;
    packagingType: string;
    coaIncluded: boolean;
  }[];
  packages: ShipmentPackage[];
  inserts: { disclosure: true; coa: boolean; receipt: boolean };
  checklistSavedAt: string | null;
  status: Shipment["status"];
}

export interface CommercialInvoiceData {
  invoiceNumber: string;
  invoiceDate: Date;
  orderNumber: string;
  exporter: PrintParty & { idLine: string };
  consignee: PrintParty;
  destination: string;
  waybill: string | null;
  carrierName: string | null;
  incoterm: string;
  reasonForExport: string;
  currency: Currency;
  lines: {
    description: string;
    hsCode: string;
    exportCode: string;
    importCode: string;
    origin: string;
    quantity: 1;
    unitValueMinor: number;
  }[];
  goodsTotalMinor: number;
  shippingMinor: number;
  insuranceMinor: number;
  invoiceTotalMinor: number;
  packages: ShipmentPackage[];
  grossWeightG: number;
  exportDeclaration: { status: string; number: string | null };
  euStatement: string | null;
  originStatement: string;
  signatureName: string;
}

async function load(db: DbOrTx, orderId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const [shipment] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.orderId, order.id));
  const rows = await db
    .select({ item: orderItems, art: artworks })
    .from(orderItems)
    .innerJoin(artworks, eq(artworks.id, orderItems.artworkId))
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.createdAt));
  const profile = await getSetting("business_profile", db);
  return { order, shipment: shipment ?? null, rows, profile };
}

function recipient(o: {
  shipName: string | null;
  buyerName: string | null;
  buyerCompanyName: string | null;
  shipLine1: string | null;
  shipLine2: string | null;
  shipCity: string | null;
  shipPostalCode: string | null;
  shipRegion: string | null;
  shipCountry: string;
  shipPhone: string | null;
  buyerPhone: string | null;
  buyerEmail: string | null;
}): PrintParty {
  return {
    name: o.shipName ?? o.buyerName ?? "",
    ...(o.buyerCompanyName ? { company: o.buyerCompanyName } : {}),
    lines: [
      o.shipLine1,
      o.shipLine2,
      [o.shipPostalCode, o.shipCity].filter(Boolean).join(" "),
      o.shipRegion,
      o.shipCountry,
    ].filter((l): l is string => !!l),
    ...((o.shipPhone ?? o.buyerPhone)
      ? { phone: (o.shipPhone ?? o.buyerPhone) as string }
      : {}),
    ...(o.buyerEmail ? { email: o.buyerEmail } : {}),
  };
}

export async function getPackingSlip(
  _ctx: AdminContext,
  orderId: string,
  locale: Locale,
  deps: { db?: DbOrTx } = {},
): Promise<PackingSlipData | null> {
  const data = await load(deps.db ?? defaultDb, orderId);
  if (!data?.shipment) return null;
  const { order, shipment, rows, profile } = data;
  const checklist = shipment.checklist as { savedAt?: string } | null;
  return {
    orderNumber: order.number,
    createdAt: new Date(),
    from: {
      name: profile.tradeName[locale],
      lines: [profile.returnAddress[locale] || profile.address[locale]],
      phone: profile.phoneLocal,
      email: profile.email,
    },
    to: recipient(order),
    method: shipment.method,
    carrierName: shipment.carrierName,
    trackingNumber: shipment.trackingNumber,
    items: rows.map(({ item, art }) => ({
      title: locale === "he" ? item.titleHe : item.titleEn,
      inventoryNumber: art.inventoryNumber,
      heightMm: art.heightMm,
      widthMm: art.widthMm,
      depthMm: art.depthMm,
      packagingType: art.packagingType,
      coaIncluded: art.coaIncluded,
    })),
    packages: (shipment.packages ?? []) as ShipmentPackage[],
    inserts: {
      disclosure: true,
      coa: rows.some((r) => r.art.coaIncluded),
      receipt: !(order.receiptEmailConsent ?? false),
    },
    checklistSavedAt: checklist?.savedAt ?? null,
    status: shipment.status,
  };
}

export async function getCommercialInvoice(
  _ctx: AdminContext,
  orderId: string,
  deps: { db?: DbOrTx } = {},
): Promise<CommercialInvoiceData | null> {
  const data = await load(deps.db ?? defaultDb, orderId);
  if (!data?.shipment || data.order.shipCountry === "IL") return null;
  const { order, shipment, rows, profile } = data;
  const currency = (shipment.declaredCurrency ?? order.currency) as Currency;
  const lines = rows.map(({ item, art }) => ({
    description:
      rows.length === 1 && shipment.contentsDescriptionEn
        ? shipment.contentsDescriptionEn
        : customsDescriptionEn({
            mediumText:
              art.mediumDetailEn?.trim() ||
              `${art.medium.toLowerCase().replace(/_/g, " ")} on ${art.surface.toLowerCase().replace(/_/g, " ")}`,
            yearCreated: art.yearCreated,
            artistName: profile.artistName.en,
          }),
    hsCode: shipment.hsCode ?? HS_CODE,
    exportCode: EXPORT_COMMODITY_CODE,
    importCode: importCommodityCode(order.shipCountry),
    origin: art.countryOfOrigin ?? "IL",
    quantity: 1 as const,
    unitValueMinor: item.declaredValueMinor ?? item.priceMinor,
  }));
  const goodsTotalMinor = lines.reduce((s, l) => s + l.unitValueMinor, 0);
  const packages = (shipment.packages ?? []) as ShipmentPackage[];
  const idLine = profile.vatNumber
    ? `VAT / business no. ${profile.vatNumber}`
    : `Business ID ${profile.idNumber}`;
  return {
    invoiceNumber:
      shipment.commercialInvoiceNumber ?? commercialInvoiceNumber(order.number),
    invoiceDate: shipment.shippedAt ?? new Date(),
    orderNumber: order.number,
    exporter: {
      name: profile.legalName,
      company: profile.tradeName.en,
      lines: [profile.address.en, "Israel"],
      phone: profile.phoneIntl,
      email: profile.email,
      idLine,
    },
    consignee: recipient(order),
    destination: order.shipCountry,
    waybill: shipment.trackingNumber,
    carrierName: shipment.carrierName,
    incoterm: shipment.incoterm ?? "DAP",
    reasonForExport: "Permanent export – sale of an original work of art",
    currency,
    lines,
    goodsTotalMinor,
    shippingMinor: order.shippingMinor,
    insuranceMinor: order.insuranceMinor,
    invoiceTotalMinor:
      goodsTotalMinor + order.shippingMinor + order.insuranceMinor,
    packages,
    grossWeightG: packages.reduce((s, p) => s + p.weightG, 0),
    exportDeclaration: {
      status: shipment.exportDeclStatus,
      number: shipment.exportDeclarationNumber,
    },
    euStatement: isEuCountry(order.shipCountry)
      ? EU_CULTURAL_GOODS_STATEMENT
      : null,
    originStatement: ORIGIN_STATEMENT,
    signatureName: profile.signatureName,
  };
}
