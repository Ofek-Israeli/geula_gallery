import "server-only";
import type { IsraelPostTariff } from "./types";

/**
 * Israel Post's published 2026 prices and limits, as pure data in ILS minor units (prices include
 * VAT where Israel Post's price list says so).
 *
 * - Domestic: "שירותים מהירים – פנים", 1.1 "מאשנב לדלת מהיום למחר" (counter to door, next day;
 *   2 business days outside the listed localities), price list of 1 May 2026. The inter-city column
 *   is used (the buyer is usually in another city); the in-city one is kept for reference. Limits
 *   from the postal guide (מדריך הדואר, parcels 3.10.18–3.10.20): 20 kg; no side over 150 cm;
 *   longest + girth (2 × the other two) at most 300 cm.
 * - Abroad: EMS, "EMS לכל פריט ללקוחות פרטיים" (counter price per item), price list of 1 July 2026,
 *   by destination group (the same list's country table, "EMS" column; "X" = no service). Israel
 *   Post prices EMS by actual weight: the price list and the guide's EMS chapter mention no
 *   volumetric weight. Size limits per destination come from the same list's parcel table
 *   (105/200 or 150/300 cm; its unclear entries, "-2" or blank, take the stricter 105/200);
 *   20 kg everywhere. Liability extension: ₪6.90 per ₪1,000 of value, up to ₪25,000.
 *
 * Checked on 2026-10-10 against the PDFs (pages rendered and read). A new price list replaces the
 * numbers here; `tests/unit/israel-post.test.ts` pins them.
 */
// biome-ignore format: published tables keep their columns
export const ISRAEL_POST_2026: IsraelPostTariff = {
  id: "ISRAEL-POST-2026",
  name: "Israel Post price lists 2026 (domestic 1 May, EMS 1 July)",
  checkedOn: "2026-10-10",
  sources: {
    domestic:
      "https://cdn-mypostpublic.israelpost.co.il/media/media/to3b3pim/%D7%9E%D7%94%D7%99%D7%A8%D7%99%D7%9D-%D7%A4%D7%A0%D7%99%D7%9D.pdf",
    ems: "https://cdn-mypostpublic.israelpost.co.il/media/media/z44bfxii/%D7%9E%D7%94%D7%99%D7%A8-%D7%97%D7%95%D7%9C.pdf",
    postalGuide:
      "https://israelpost.co.il/media/3429/%D7%9E%D7%93%D7%A8%D7%99%D7%9A-%D7%94%D7%93%D7%95%D7%90%D7%A8-%D7%A0%D7%95%D7%A1%D7%97-%D7%9C%D7%A4%D7%A8%D7%A1%D7%95%D7%9D-161845.pdf",
  },
  domestic: {
    validFrom: "2026-05-01",
    bands: [
      { upToG: 1_000, minor: 6_700 },
      { upToG: 10_000, minor: 7_300 },
      { upToG: 20_000, minor: 8_600 },
    ],
    inCityBands: [
      { upToG: 1_000, minor: 4_500 },
      { upToG: 10_000, minor: 5_600 },
      { upToG: 20_000, minor: 6_700 },
    ],
    maxWeightG: 20_000,
    limit: { maxSideCm: 150, maxLengthGirthCm: 300 },
  },
  ems: {
    validFrom: "2026-07-01",
    groups: {
      1: { upTo500: 17_500, upTo1000: 20_600, perExtra500: 3_150 },
      2: { upTo500: 16_800, upTo1000: 21_300, perExtra500: 4_600 },
      3: { upTo500: 17_400, upTo1000: 18_400, perExtra500: 1_150 },
      4: { upTo500: 15_200, upTo1000: 17_100, perExtra500: 2_400 },
      5: { upTo500: 14_300, upTo1000: 16_100, perExtra500: 2_050 },
      6: { upTo500: 15_600, upTo1000: 18_200, perExtra500: 3_400 },
      7: { upTo500: 15_100, upTo1000: 18_300, perExtra500: 2_850 },
      8: { upTo500: 16_500, upTo1000: 18_800, perExtra500: 2_300 },
      9: { upTo500: 20_800, upTo1000: 23_000, perExtra500: 2_000 },
      10: { upTo500: 16_100, upTo1000: 17_700, perExtra500: 1_350 },
      11: { upTo500: 20_900, upTo1000: 22_100, perExtra500: 1_350 },
      12: { upTo500: 16_900, upTo1000: 18_300, perExtra500: 1_100 },
      13: { upTo500: 20_800, upTo1000: 21_800, perExtra500: 1_300 },
    },
    countryGroups: {
      1: ["US"],
      2: ["AU", "BI", "BW", "GW", "KZ", "MR", "ZA"],
      3: [
        "AE", "AT", "BE", "BH", "CH", "CY", "CZ", "DE", "EG", "ES", "FR", "GB", "HU", "IE", "IT", "JO",
        "LU", "MC", "MV", "NL", "PL", "PT", "TR",
      ],
      4: [
        "AM", "AW", "AZ", "BB", "BD", "CA", "CG", "CW", "DJ", "DO", "EE", "IN", "KE", "KG", "LA", "LS",
        "MT", "MX", "MZ", "NG", "PE", "RW", "SN", "SZ", "TD", "TN", "TW", "TZ", "UG", "UZ", "ZW",
      ],
      5: ["BM", "BT", "CN", "GH", "HK", "HT", "JP", "KH", "KR", "MM", "MO", "NP", "PH", "SG", "TH"],
      6: [
        "AR", "BF", "BR", "CD", "CF", "CI", "CK", "CL", "CM", "EC", "GN", "JM", "LK", "ML", "MN", "NA",
        "NE", "NZ", "PY", "SC", "SL", "SV", "TG", "UY", "VE", "VN", "VU", "ZM",
      ],
      7: [
        "AO", "AS", "CO", "CU", "FJ", "FM", "GU", "HN", "ID", "MH", "MP", "NI", "NR", "PF", "PG", "SB",
        "TT",
      ],
      8: ["BJ", "BO", "CR", "GA", "MG", "MU", "NC", "PA", "SR"],
      9: ["BS", "GI", "GY", "KY", "MY", "TJ"],
      10: [
        "AD", "AL", "BA", "BG", "BY", "CV", "ET", "GF", "GP", "GR", "HR", "LT", "LV", "MA", "MD", "ME",
        "MK", "MQ", "PM", "RE", "RO", "RS", "SI", "SK", "TM", "UA", "VA",
      ],
      11: ["RU"],
      12: ["GE"],
      13: ["DK", "FI", "IS", "NO", "SE"],
    },
    maxWeightG: 20_000,
    limits: [
      { maxSideCm: 100, maxLengthGirthCm: 180, countries: ["NP"] },
      {
        maxSideCm: 105,
        maxLengthGirthCm: 200,
        countries: [
          "AL", "AR", "AS", "AU", "BB", "BM", "BR", "BS", "BT", "BW", "BY", "CD", "CF", "CK", "CV", "DE",
          "DJ", "DO", "EE", "ES", "FJ", "FM", "GU", "GW", "HN", "HR", "ID", "IN", "IT", "JM", "KE", "KG",
          "KY", "KZ", "LK", "LV", "MA", "ME", "MG", "MH", "MK", "MP", "MU", "MY", "NA", "NR", "PG", "PH",
          "RO", "RS", "SB", "TJ", "TM", "TT", "TZ", "UA", "US", "UZ", "VA", "VU", "ZA",
        ],
      },
      {
        maxSideCm: 150,
        maxLengthGirthCm: 300,
        countries: [
          "AD", "AE", "AM", "AO", "AT", "AW", "AZ", "BA", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BO",
          "CA", "CG", "CH", "CI", "CL", "CM", "CN", "CO", "CR", "CU", "CW", "CY", "CZ", "DK", "EC", "EG",
          "ET", "FI", "FR", "GA", "GB", "GE", "GF", "GH", "GI", "GN", "GP", "GR", "GY", "HK", "HT", "HU",
          "IE", "IS", "JO", "JP", "KH", "KR", "LA", "LS", "LT", "LU", "MC", "MD", "ML", "MM", "MN", "MO",
          "MQ", "MR", "MT", "MV", "MX", "MZ", "NC", "NE", "NG", "NI", "NL", "NO", "NZ", "PA", "PE", "PF",
          "PL", "PM", "PT", "PY", "RE", "RU", "RW", "SC", "SE", "SG", "SI", "SK", "SL", "SN", "SR", "SV",
          "SZ", "TD", "TG", "TH", "TN", "TR", "TW", "UG", "UY", "VE", "VN", "ZM", "ZW",
        ],
      },
    ],
    insurance: { perThousandMinor: 690, maxValueMinor: 2_500_000 },
  },
};
