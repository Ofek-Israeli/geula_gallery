import "server-only";
import { z } from "zod";
import { jerusalemOffsetMinutes } from "@/lib/format";
import type { ShipmentStatus } from "@/server/domain/state-machines";
import type { components } from "@/server/integrations/generated/dhl-mydhl";
import { importCommodityCode } from "../customs";
import type {
  CreateShipmentRequest,
  NormalizedTrackingEvent,
  PickupRequest,
  ShipmentPackage,
  ShipmentParty,
} from "../types";

/**
 * Pure DHL Express MyDHL 3.3.2 mapping (spec §4.4, §10.1 `dhl-builder`, `dhl-map`):
 * - request builders whose results `satisfies` the generated request types;
 * - response parsing with zod (only the fields we rely on);
 * - tracking checkpoint codes → shipment status. **Unknown codes record an event and never change
 *   the status** (`status: null`).
 *
 * The checkpoint table below holds the common DHL Express codes; verify it against the current
 * DHL checkpoint list once a real account exists (go-live item). Every builder outputs the text it
 * is given: the caller validates that addresses are Latin (spec §4.4 "Addresses").
 */
type Schemas = components["schemas"];
export type DhlCreateShipmentRequest =
  Schemas["supermodelIoLogisticsExpressCreateShipmentRequest"];
export type DhlPickupRequest =
  Schemas["supermodelIoLogisticsExpressPickupRequest"];
type DhlParty = DhlCreateShipmentRequest["customerDetails"]["shipperDetails"];
type DhlPackage = Schemas["supermodelIoLogisticsExpressPackage"];
type DhlLineItem = NonNullable<
  DhlCreateShipmentRequest["content"]["exportDeclaration"]
>["lineItems"][number];
type DhlVas = Schemas["supermodelIoLogisticsExpressValueAddedServices"];

/** The API version sent as `x-version` (the generated types are from 3.3.2). */
export const DHL_API_VERSION = "3.3.2";
/** Express Worldwide, non-document (spec §4.4: `productCode "P"`). */
export const DHL_PRODUCT_CODE = "P";
/** Value-added services: shipment insurance and Paperless Trade. */
export const DHL_VAS_INSURANCE = "II";
export const DHL_VAS_PAPERLESS = "WY";

// ---------------------------------------------------------------- units and formats

/** Minor units → major units (DHL takes decimal numbers). */
export function toMajor(minor: number): number {
  return Math.round(minor) / 100;
}

/** mm → whole cm, rounded up (the carrier never measures less than the box). */
export function mmToCmCeil(mm: number): number {
  return Math.max(1, Math.ceil(mm / 10));
}

/** g → kg with three decimals, at least 0.001. */
export function gToKg(g: number): number {
  return Math.max(0.001, Math.round(g) / 1000);
}

/** `2026-10-05` → `2026-10-05T10:00:00 GMT+03:00` (DHL's format; the Jerusalem offset of that day). */
export function dhlPlannedShippingDateAndTime(
  isoDate: string,
  time = "10:00:00",
): string {
  const offset = jerusalemOffsetMinutes(new Date(`${isoDate}T12:00:00Z`));
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${isoDate}T${time} GMT${sign}${hh}:${mm}`;
}

// ---------------------------------------------------------------- builders

function party(p: ShipmentParty, typeCode: "business" | "private"): DhlParty {
  const a = p.address;
  return {
    postalAddress: {
      postalCode: a.postalCode ?? "",
      cityName: a.city,
      countryCode: a.country,
      addressLine1: a.line1,
      ...(a.line2 ? { addressLine2: a.line2 } : {}),
      ...(a.region ? { provinceName: a.region } : {}),
    },
    contactInformation: {
      email: p.email,
      phone: a.phone,
      companyName: p.companyName || p.name,
      fullName: p.name,
    },
    typeCode,
  };
}

function dhlPackage(p: ShipmentPackage, orderNumber: string): DhlPackage {
  return {
    weight: gToKg(p.weightG),
    dimensions: {
      length: mmToCmCeil(p.lengthMm),
      width: mmToCmCeil(p.widthMm),
      height: mmToCmCeil(p.heightMm),
    },
    customerReferences: [{ typeCode: "CU", value: orderNumber }],
    description: "Original painting",
  };
}

/**
 * `POST /shipments` body (spec §4.4): product P, the shipper account, Latin customer details,
 * packages in cm/kg, customs declarable with declared value and currency, incoterm DAP, an export
 * declaration with outbound `9701910000` and the inbound code per destination, reason
 * "permanent", manufacturer country IL, invoice `CI-<orderNumber>`; `II` only when insured, `WY`
 * only with paperless trade; label plus DHL commercial invoice; customer reference = order number.
 */
export function buildDhlShipmentRequest(
  r: CreateShipmentRequest,
  o: { accountNumber: string; plannedShippingDateAndTime: string },
): DhlCreateShipmentRequest {
  const currency = r.declaredCurrency;
  const vas: DhlVas[] = [];
  if (r.insuredValueMinor !== undefined && r.insuredValueMinor > 0) {
    vas.push({
      serviceCode: DHL_VAS_INSURANCE,
      value: toMajor(r.insuredValueMinor),
      currency,
    });
  }
  if (r.paperlessTrade) vas.push({ serviceCode: DHL_VAS_PAPERLESS });

  const destination = r.recipient.address.country;
  const lineItems: DhlLineItem[] = r.lineItems.map((li, i) => ({
    number: i + 1,
    description: li.description,
    price: toMajor(li.valueMinor),
    quantity: { value: li.quantity, unitOfMeasurement: "PCS" },
    commodityCodes: [
      { typeCode: "outbound", value: li.exportCommodityCode },
      {
        typeCode: "inbound",
        value: li.importCommodityCode ?? importCommodityCode(destination),
      },
    ],
    exportReasonType: r.exportReason,
    manufacturerCountry: li.originCountry,
    weight: { netValue: gToKg(li.weightG), grossValue: gToKg(li.weightG) },
  }));

  return {
    plannedShippingDateAndTime: o.plannedShippingDateAndTime,
    pickup: { isRequested: false },
    productCode: DHL_PRODUCT_CODE,
    getRateEstimates: false,
    accounts: [{ typeCode: "shipper", number: o.accountNumber }],
    ...(vas.length > 0 ? { valueAddedServices: vas } : {}),
    outputImageProperties: {
      encodingFormat: "pdf",
      imageOptions: [
        { typeCode: "label" },
        { typeCode: "invoice", isRequested: true, invoiceType: "commercial" },
      ],
    },
    customerReferences: [{ typeCode: "CU", value: r.orderNumber }],
    customerDetails: {
      shipperDetails: party(r.shipper, "business"),
      receiverDetails: party(r.recipient, "private"),
    },
    content: {
      packages: r.packages.map((p) => dhlPackage(p, r.orderNumber)),
      isCustomsDeclarable: r.isCustomsDeclarable,
      declaredValue: toMajor(r.declaredValueMinor),
      declaredValueCurrency: currency,
      exportDeclaration: {
        lineItems,
        invoice: { number: r.invoiceNumber, date: r.plannedShippingDate },
        exportReasonType: r.exportReason,
        exportReason: "Sale of an original work of art",
        shipmentType: "commercial",
      },
      description: r.contentsDescriptionEn.slice(0, 70),
      incoterm: r.incoterm,
      unitOfMeasurement: "metric",
    },
  } satisfies DhlCreateShipmentRequest;
}

/** `POST /pickups` body for already-labelled shipments (spec §4.4 "Other operations"). */
export function buildDhlPickupRequest(
  r: PickupRequest,
  o: { accountNumber: string },
): DhlPickupRequest {
  const a = r.location.address;
  const address = {
    postalCode: a.postalCode ?? "",
    cityName: a.city,
    countryCode: a.country,
    addressLine1: a.line1,
    ...(a.line2 ? { addressLine2: a.line2 } : {}),
  };
  const contact = {
    email: r.location.email,
    phone: a.phone,
    companyName: r.location.companyName || r.location.name,
    fullName: r.location.name,
  };
  return {
    plannedPickupDateAndTime: dhlPlannedShippingDateAndTime(
      r.plannedDate,
      `${r.readyByTime}:00`,
    ),
    closeTime: r.closeTime,
    location: "reception",
    locationType: "business",
    accounts: [{ typeCode: "shipper", number: o.accountNumber }],
    customerDetails: {
      shipperDetails: { postalAddress: address, contactInformation: contact },
    },
    shipmentDetails: r.waybills.map((waybill) => ({
      productCode: DHL_PRODUCT_CODE,
      isCustomsDeclarable: true,
      unitOfMeasurement: "metric" as const,
      shipmentTrackingNumber: waybill,
      packages: r.packages.map((p) => ({
        weight: gToKg(p.weightG),
        dimensions: {
          length: mmToCmCeil(p.lengthMm),
          width: mmToCmCeil(p.widthMm),
          height: mmToCmCeil(p.heightMm),
        },
      })),
    })),
  } satisfies DhlPickupRequest;
}

// ---------------------------------------------------------------- responses

const documentSchema = z.object({
  imageFormat: z.string(),
  content: z.string().min(1),
  typeCode: z.string(),
});

/** The fields of the `POST /shipments` 201 response we rely on. */
export const dhlCreateShipmentResponseSchema = z.object({
  shipmentTrackingNumber: z.string().regex(/^[0-9A-Z]{6,20}$/),
  trackingUrl: z.string().optional(),
  documents: z.array(documentSchema).optional(),
  packages: z
    .array(
      z.object({
        trackingNumber: z.string(),
        documents: z.array(documentSchema).optional(),
      }),
    )
    .optional(),
  warnings: z.array(z.string()).optional(),
});
export type DhlCreateShipmentResponse = z.infer<
  typeof dhlCreateShipmentResponseSchema
>;

function allDocuments(res: DhlCreateShipmentResponse) {
  return [
    ...(res.documents ?? []),
    ...(res.packages ?? []).flatMap((p) => p.documents ?? []),
  ];
}

/** Decodes a base64 PDF document of `typeCode` (`label`, `invoice`, `waybillDoc`). */
export function dhlDocument(
  res: DhlCreateShipmentResponse,
  typeCode: string,
): Uint8Array | undefined {
  const doc = allDocuments(res).find(
    (d) => d.typeCode === typeCode && d.imageFormat.toUpperCase() === "PDF",
  );
  return doc ? new Uint8Array(Buffer.from(doc.content, "base64")) : undefined;
}

/**
 * What we keep of a create-shipment response (`shipments.provider_response_redacted`): no base64
 * documents and no customer details (names and addresses are buyer PII).
 */
export function redactDhlCreateResponse(
  res: DhlCreateShipmentResponse,
): Record<string, unknown> {
  return {
    shipmentTrackingNumber: res.shipmentTrackingNumber,
    packages: (res.packages ?? []).map((p) => ({
      trackingNumber: p.trackingNumber,
    })),
    documents: allDocuments(res).map((d) => ({
      typeCode: d.typeCode,
      imageFormat: d.imageFormat,
    })),
    warnings: res.warnings ?? [],
  };
}

export const dhlPickupResponseSchema = z.object({
  dispatchConfirmationNumbers: z.array(z.string().min(1)).min(1),
});

// ---------------------------------------------------------------- tracking

/**
 * DHL Express checkpoint codes → shipment status. Codes not listed, and listed codes mapped to
 * `null`, are recorded as events without changing the status.
 */
export const DHL_CHECKPOINT_STATUS: Readonly<
  Record<string, ShipmentStatus | null>
> = {
  // Moving through the network.
  PU: "IN_TRANSIT", // shipment picked up
  PL: "IN_TRANSIT", // processed at location
  DF: "IN_TRANSIT", // departed facility
  AF: "IN_TRANSIT", // arrived at facility
  AR: "IN_TRANSIT", // arrived at delivery facility
  TR: "IN_TRANSIT", // transferred through
  // Customs.
  CR: "CUSTOMS", // clearance release / customs status updated
  RR: "CUSTOMS", // customs status updated
  CD: "CUSTOMS", // clearance delay
  HP: "CUSTOMS", // held for payment (duties and taxes)
  // Last mile.
  WC: "OUT_FOR_DELIVERY", // with delivery courier
  OK: "DELIVERED", // delivered
  // Problems.
  NH: "EXCEPTION", // not home
  BA: "EXCEPTION", // bad address
  CA: "EXCEPTION", // closed on arrival
  MD: "EXCEPTION", // missed delivery cycle
  RD: "EXCEPTION", // refused delivery
  OH: "EXCEPTION", // on hold
  RT: "RETURNED", // returned to shipper
  // Informational only.
  SA: null, // shipment acknowledged
  CC: null, // awaiting collection by recipient as requested
};

export function dhlStatusForCode(code: string): ShipmentStatus | null {
  return DHL_CHECKPOINT_STATUS[code.toUpperCase()] ?? null;
}

const trackingEventSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  GMTOffset: z
    .string()
    .regex(/^[+-]\d{2}:\d{2}$/)
    .optional(),
  typeCode: z.string().optional(),
  description: z.string().optional(),
  serviceArea: z
    .array(z.object({ description: z.string().optional() }))
    .optional(),
});

export const dhlTrackingResponseSchema = z.object({
  shipments: z
    .array(
      z.object({
        shipmentTrackingNumber: z.string().optional(),
        events: z.array(trackingEventSchema),
        estimatedDeliveryDate: z.string().optional(),
      }),
    )
    .default([]),
});

/**
 * Tracking response → events sorted by time, oldest first. Times are the facility's local time
 * plus `GMTOffset` (requested per event); a missing offset is read as UTC.
 */
export function mapDhlTrackingEvents(raw: unknown): NormalizedTrackingEvent[] {
  const parsed = dhlTrackingResponseSchema.parse(raw);
  return parsed.shipments
    .flatMap((s) => s.events)
    .map((e) => {
      const time = e.time.length === 5 ? `${e.time}:00` : e.time;
      const occurredAt = new Date(
        `${e.date}T${time}${e.GMTOffset ?? "Z"}`,
      ).toISOString();
      const code = (e.typeCode ?? "").toUpperCase();
      const location = e.serviceArea?.[0]?.description;
      return {
        occurredAt,
        code,
        description: e.description ?? code,
        ...(location ? { location } : {}),
        status: code ? dhlStatusForCode(code) : null,
      } satisfies NormalizedTrackingEvent;
    })
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/** The time of the first delivered event, if any. */
export function deliveredAtOf(
  events: readonly NormalizedTrackingEvent[],
): string | undefined {
  return events.find((e) => e.status === "DELIVERED")?.occurredAt;
}
