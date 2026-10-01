import { describe, expect, it } from "vitest";
import {
  buildDhlPickupRequest,
  buildDhlShipmentRequest,
  dhlPlannedShippingDateAndTime,
  gToKg,
  mmToCmCeil,
} from "@/server/shipping/carriers/dhl-map";
import { sampleShipmentRequest } from "../helpers/factories/shipping";

/**
 * Spec §10.1 `dhl-builder`: the request builders `satisfies` the generated MyDHL 3.3.2 types
 * (checked by tsc) and produce the §4.4 content: product P, DAP, export declaration with
 * 9701910000 outbound and the destination code inbound, reason permanent, manufacturer IL,
 * invoice CI-<order>, II only when insured, WY only with paperless trade, customer reference.
 */
const opts = {
  accountNumber: "TESTACCOUNT",
  plannedShippingDateAndTime: "2026-10-05T10:00:00 GMT+03:00",
};

describe("buildDhlShipmentRequest", () => {
  it("builds the §4.4 shipment (snapshot of the stable fields)", () => {
    const body = buildDhlShipmentRequest(sampleShipmentRequest(), opts);
    expect(body).toMatchInlineSnapshot(`
      {
        "accounts": [
          {
            "number": "TESTACCOUNT",
            "typeCode": "shipper",
          },
        ],
        "content": {
          "declaredValue": 870,
          "declaredValueCurrency": "USD",
          "description": "Original painting (oil on cardboard)",
          "exportDeclaration": {
            "exportReason": "Sale of an original work of art",
            "exportReasonType": "permanent",
            "invoice": {
              "date": "2026-10-05",
              "number": "CI-GG-TEST01",
            },
            "lineItems": [
              {
                "commodityCodes": [
                  {
                    "typeCode": "outbound",
                    "value": "9701910000",
                  },
                  {
                    "typeCode": "inbound",
                    "value": "9701.91.0000",
                  },
                ],
                "description": "Original painting, oil on cardboard, by Test Artist (2024). Hand-painted unique work of art, not a reproduction.",
                "exportReasonType": "permanent",
                "manufacturerCountry": "IL",
                "number": 1,
                "price": 870,
                "quantity": {
                  "unitOfMeasurement": "PCS",
                  "value": 1,
                },
                "weight": {
                  "grossValue": 2.058,
                  "netValue": 2.058,
                },
              },
            ],
            "shipmentType": "commercial",
          },
          "incoterm": "DAP",
          "isCustomsDeclarable": true,
          "packages": [
            {
              "customerReferences": [
                {
                  "typeCode": "CU",
                  "value": "GG-TEST01",
                },
              ],
              "description": "Original painting",
              "dimensions": {
                "height": 9,
                "length": 43,
                "width": 43,
              },
              "weight": 2.058,
            },
          ],
          "unitOfMeasurement": "metric",
        },
        "customerDetails": {
          "receiverDetails": {
            "contactInformation": {
              "companyName": "Test Receiver",
              "email": "buyer@example.test",
              "fullName": "Test Receiver",
              "phone": "+97230000000",
            },
            "postalAddress": {
              "addressLine1": "1 Example Avenue",
              "addressLine2": "Apt 2",
              "cityName": "New York",
              "countryCode": "US",
              "postalCode": "10001",
              "provinceName": "NY",
            },
            "typeCode": "private",
          },
          "shipperDetails": {
            "contactInformation": {
              "companyName": "Test Studio",
              "email": "studio@example.com",
              "fullName": "Test Shipper",
              "phone": "+97230000000",
            },
            "postalAddress": {
              "addressLine1": "1 Test Street",
              "cityName": "Tel Aviv",
              "countryCode": "IL",
              "postalCode": "6100000",
            },
            "typeCode": "business",
          },
        },
        "customerReferences": [
          {
            "typeCode": "CU",
            "value": "GG-TEST01",
          },
        ],
        "getRateEstimates": false,
        "outputImageProperties": {
          "encodingFormat": "pdf",
          "imageOptions": [
            {
              "typeCode": "label",
            },
            {
              "invoiceType": "commercial",
              "isRequested": true,
              "typeCode": "invoice",
            },
          ],
        },
        "pickup": {
          "isRequested": false,
        },
        "plannedShippingDateAndTime": "2026-10-05T10:00:00 GMT+03:00",
        "productCode": "P",
        "valueAddedServices": [
          {
            "currency": "USD",
            "serviceCode": "II",
            "value": 870,
          },
        ],
      }
    `);
  });

  it("adds II only when insured and WY only with paperless trade", () => {
    const uninsured = buildDhlShipmentRequest(
      sampleShipmentRequest({ insuredValueMinor: undefined }),
      opts,
    );
    expect(uninsured.valueAddedServices).toBeUndefined();
    const paperless = buildDhlShipmentRequest(
      sampleShipmentRequest({ insuredValueMinor: 0, paperlessTrade: true }),
      opts,
    );
    expect(paperless.valueAddedServices).toEqual([{ serviceCode: "WY" }]);
  });

  it("uses the destination's inbound code when the line item has none", () => {
    const base = sampleShipmentRequest();
    const toDe = sampleShipmentRequest({
      recipient: {
        ...base.recipient,
        address: { ...base.recipient.address, country: "DE" },
      },
      lineItems: base.lineItems.map(({ importCommodityCode: _, ...li }) => li),
    });
    const codes = buildDhlShipmentRequest(toDe, opts).content.exportDeclaration
      ?.lineItems[0]?.commodityCodes;
    expect(codes).toEqual([
      { typeCode: "outbound", value: "9701910000" },
      { typeCode: "inbound", value: "97019100" },
    ]);
  });

  it("never sends Hebrew: the sample is Latin end to end", () => {
    const json = JSON.stringify(
      buildDhlShipmentRequest(sampleShipmentRequest(), opts),
    );
    expect(json).not.toMatch(/[֐-׿]/);
  });

  it("caps the contents description at 70 characters", () => {
    const body = buildDhlShipmentRequest(
      sampleShipmentRequest({ contentsDescriptionEn: "x".repeat(90) }),
      opts,
    );
    expect(body.content.description).toHaveLength(70);
  });
});

describe("units and dates", () => {
  it("rounds packages up to whole cm and keeps grams to the kg decimal", () => {
    expect(mmToCmCeil(425)).toBe(43);
    expect(mmToCmCeil(420)).toBe(42);
    expect(mmToCmCeil(1)).toBe(1);
    expect(gToKg(2058)).toBe(2.058);
    expect(gToKg(0)).toBe(0.001);
  });

  it("formats the planned time with the Jerusalem offset of that day", () => {
    expect(dhlPlannedShippingDateAndTime("2026-10-05")).toBe(
      "2026-10-05T10:00:00 GMT+03:00",
    );
    expect(dhlPlannedShippingDateAndTime("2026-12-01")).toBe(
      "2026-12-01T10:00:00 GMT+02:00",
    );
  });
});

describe("buildDhlPickupRequest", () => {
  it("books a pickup for the labelled waybills", () => {
    const r = sampleShipmentRequest();
    const body = buildDhlPickupRequest(
      {
        plannedDate: "2026-10-05",
        readyByTime: "10:00",
        closeTime: "17:00",
        location: r.shipper,
        packages: r.packages,
        waybills: ["1234567890"],
      },
      { accountNumber: "TESTACCOUNT" },
    );
    expect(body.plannedPickupDateAndTime).toBe("2026-10-05T10:00:00 GMT+03:00");
    expect(body.closeTime).toBe("17:00");
    expect(body.accounts).toEqual([
      { typeCode: "shipper", number: "TESTACCOUNT" },
    ]);
    expect(body.shipmentDetails[0]).toMatchObject({
      productCode: "P",
      shipmentTrackingNumber: "1234567890",
      unitOfMeasurement: "metric",
      packages: [
        { weight: 2.058, dimensions: { length: 43, width: 43, height: 9 } },
      ],
    });
  });
});
