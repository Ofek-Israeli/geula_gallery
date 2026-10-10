import "server-only";
import type { DhlTariff } from "./types";

/**
 * DHL Express Worldwide (non-documents) export prices from Israel, as DHL publishes them for 2026.
 * Pure data, ILS minor units (agorot), excluding VAT, duties and taxes.
 *
 * - Rates, zones, billing rules, piece limits: "DHL Express Service & Rate Guide 2026: Israel"
 *   (valid from 1 January 2026), pages 24–27. The rows were extracted from the PDF text, not
 *   retyped; `tests/unit/dhl-tariff.test.ts` checks every 11–30 kg and 40–70 kg row against the
 *   published increments.
 * - Surcharges (Oversize, Overweight, Non-Conveyable, Restricted Destination, Elevated Risk,
 *   Remote Area) and the fuel surcharge rules: DHL's Israel surcharges page.
 * - Demand surcharge: DHL's Israel demand-surcharge page (Israel is an origin in DHL's "Europe";
 *   Time Definite International, 1 Oct 2026 – 5 Feb 2027, ILS per kg of billing weight).
 * - Elevated Risk: DHL suspended the surcharge on shipments to and from Israel on 25 Sep 2026
 *   (DHL notices page); it still applies to the destinations DHL lists.
 * - Export Declaration (customs service, 110 ILS + VAT) and Shipment Insurance (1%, min 45 ILS):
 *   the guide's optional and customs services tables.
 *
 * Checked on 2026-10-10. A new guide is added as a new tariff in `index.ts` (`DHL_TARIFFS`).
 */
// biome-ignore format: published tables keep their columns
export const DHL_EXPRESS_IL_2026: DhlTariff = {
  id: "DHL-EXPRESS-WORLDWIDE-IL-2026",
  name: "DHL Express Service & Rate Guide 2026: Israel",
  validFrom: "2026-01-01",
  reviewBy: "2027-01-01",
  checkedOn: "2026-10-10",
  sources: {
    rateGuide:
      "https://mydhl.express.dhl/content/dam/downloads/il/en/rate-guide/service_and%20rate_guide_il_en_2026.pdf.coredownload.pdf",
    surcharges: "https://mydhl.express.dhl/il/en/ship/surcharges.html",
    demandSurcharge:
      "https://mydhl.express.dhl/il/en/ship/surcharges/demand-surcharge.html",
    notices:
      "https://mydhl.express.dhl/us/en/important-information.important-info-active-items.html",
    customsServices: "https://mydhl.express.dhl/il/en/ship/customs-services.html",
  },
  divisorCm3PerKg: 5000,
  // [weight in half-kilos, [zone 1 … zone 6]]: 0.5–10 kg by 0.5 kg, 11–30 kg by 1 kg, 40–70 kg.
  rows: [
    [  1, [   18_556,    19_126,    23_514,    25_808,    26_408,    32_155]],
    [  2, [   28_488,    35_877,    41_444,    45_390,    48_792,    57_341]],
    [  3, [   34_768,    43_149,    50_554,    55_336,    59_085,    69_538]],
    [  4, [   41_048,    50_421,    59_664,    65_282,    69_378,    81_735]],
    [  5, [   47_370,    57_715,    68_754,    75_164,    79_693,    93_932]],
    [  6, [   52_056,    63_679,    77_188,    84_353,    88_574,   104_967]],
    [  7, [   56_742,    69_643,    85_622,    93_542,    97_455,   116_002]],
    [  8, [   61_428,    75_607,    94_056,   102_731,   106_336,   127_037]],
    [  9, [   66_114,    81_571,   102_490,   111_920,   115_217,   138_072]],
    [ 10, [   70_800,    87_535,   110_924,   121_109,   124_098,   149_107]],
    [ 11, [   74_927,    91_409,   118_058,   128_607,   132_091,   158_695]],
    [ 12, [   79_054,    95_283,   125_192,   136_105,   140_084,   168_283]],
    [ 13, [   83_181,    99_157,   132_326,   143_603,   148_077,   177_871]],
    [ 14, [   87_308,   103_031,   139_460,   151_101,   156_070,   187_459]],
    [ 15, [   91_435,   106_905,   146_594,   158_599,   164_063,   197_047]],
    [ 16, [   95_562,   110_779,   153_728,   166_097,   172_056,   206_635]],
    [ 17, [   99_689,   114_653,   160_862,   173_595,   180_049,   216_223]],
    [ 18, [  103_816,   118_527,   167_996,   181_093,   188_042,   225_811]],
    [ 19, [  107_943,   122_401,   175_130,   188_591,   196_035,   235_399]],
    [ 20, [  112_070,   126_275,   182_264,   196_089,   204_028,   244_987]],
    [ 22, [  116_946,   134_127,   191_436,   206_089,   218_216,   262_495]],
    [ 24, [  121_822,   141_979,   200_608,   216_089,   232_404,   280_003]],
    [ 26, [  126_698,   149_831,   209_780,   226_089,   246_592,   297_511]],
    [ 28, [  131_574,   157_683,   218_952,   236_089,   260_780,   315_019]],
    [ 30, [  136_450,   165_535,   228_124,   246_089,   274_968,   332_527]],
    [ 32, [  141_326,   173_387,   237_296,   256_089,   289_156,   350_035]],
    [ 34, [  146_202,   181_239,   246_468,   266_089,   303_344,   367_543]],
    [ 36, [  151_078,   189_091,   255_640,   276_089,   317_532,   385_051]],
    [ 38, [  155_954,   196_943,   264_812,   286_089,   331_720,   402_559]],
    [ 40, [  160_830,   204_795,   273_984,   296_089,   345_908,   420_067]],
    [ 42, [  166_530,   212_795,   282_970,   305_853,   358_940,   435_273]],
    [ 44, [  172_230,   220_795,   291_956,   315_617,   371_972,   450_479]],
    [ 46, [  177_930,   228_795,   300_942,   325_381,   385_004,   465_685]],
    [ 48, [  183_630,   236_795,   309_928,   335_145,   398_036,   480_891]],
    [ 50, [  189_330,   244_795,   318_914,   344_909,   411_068,   496_097]],
    [ 52, [  195_030,   252_795,   327_900,   354_673,   424_100,   511_303]],
    [ 54, [  200_730,   260_795,   336_886,   364_437,   437_132,   526_509]],
    [ 56, [  206_430,   268_795,   345_872,   374_201,   450_164,   541_715]],
    [ 58, [  212_130,   276_795,   354_858,   383_965,   463_196,   556_921]],
    [ 60, [  217_830,   284_795,   363_844,   393_729,   476_228,   572_127]],
    [ 80, [  288_440,   360_895,   464_624,   502_779,   616_828,   732_537]],
    [100, [  359_050,   436_995,   565_404,   611_829,   757_428,   892_947]],
    [120, [  429_660,   513_095,   666_184,   720_879,   898_028, 1_053_357]],
    [140, [  500_270,   589_195,   766_964,   829_929, 1_038_628, 1_213_767]],
  ],
  perHalfKgAbove10: [2_438, 3_926, 4_586, 5_000, 7_094, 8_754],
  perHalfKgAbove20: [2_850, 4_000, 4_493, 4_882, 6_516, 7_603],
  perKg30To70: [7_061, 7_610, 10_078, 10_905, 14_060, 16_041],
  perKg70To300: [7_125, 7_663, 10_182, 11_044, 14_327, 16_875],
  perKg300To3000: [7_990, 8_433, 11_409, 12_568, 15_771, 18_924],
  // The guide's "Service capability and rating zones" (Israel: "–"). Kosovo (XK) and the Canary
  // Islands (zone 2, as Spain) have no ISO 3166-1 code in the selector.
  zones: {
    1: ["CA", "MX", "US"],
    2: [
      "AD", "AL", "AM", "AT", "BA", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FO",
      "FR", "GB", "GG", "GI", "GL", "GR", "HR", "HU", "IE", "IS", "IT", "JE", "LI", "LT", "LU", "LV",
      "MC", "MD", "ME", "MK", "MT", "NL", "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK", "SM", "TR",
      "UA", "VA",
    ],
    3: ["CN", "HK"],
    4: [
      "AE", "AU", "BH", "EG", "ID", "IN", "JO", "JP", "KH", "KR", "LA", "MA", "MM", "MY", "NP", "NZ",
      "OM", "PH", "PW", "SA", "SG", "TH", "TW", "VN",
    ],
    5: [
      "AR", "BO", "BR", "BZ", "CL", "CO", "CR", "DO", "EC", "GF", "GT", "GY", "HN", "NI", "PA", "PE",
      "PY", "SD", "SR", "SV", "UY", "VE",
    ],
    6: [
      "AG", "AI", "AO", "AS", "AW", "AZ", "BB", "BD", "BF", "BI", "BJ", "BL", "BM", "BN", "BQ", "BS",
      "BT", "BW", "BY", "CD", "CF", "CG", "CI", "CK", "CM", "CU", "CV", "CW", "DJ", "DM", "DZ", "ER",
      "ET", "FJ", "FK", "FM", "GA", "GD", "GE", "GH", "GM", "GN", "GP", "GQ", "GU", "GW", "HT", "IQ",
      "IR", "JM", "KE", "KG", "KI", "KM", "KN", "KP", "KW", "KY", "KZ", "LB", "LC", "LK", "LR", "LS",
      "LY", "MG", "MH", "ML", "MN", "MO", "MP", "MQ", "MR", "MS", "MU", "MV", "MW", "MZ", "NA", "NC",
      "NE", "NG", "NR", "NU", "PF", "PG", "PK", "PR", "QA", "RE", "RU", "RW", "SB", "SC", "SH", "SL",
      "SN", "SO", "SS", "ST", "SX", "SY", "SZ", "TC", "TD", "TG", "TJ", "TL", "TM", "TN", "TO", "TT",
      "TV", "TZ", "UG", "UZ", "VC", "VG", "VI", "VU", "WS", "YE", "YT", "ZA", "ZM", "ZW",
    ],
  },
  // Selector codes the guide does not list: no published price (the rate table prices them).
  noZone: [
    "AF", "AQ", "AX", "BV", "CC", "CX", "EH", "GS", "HM", "IM", "IO", "MF", "NF", "PM", "PN", "PS",
    "SJ", "TF", "TK", "UM", "WF",
  ],
  limits: { pieceLengthCm: 300, pieceWeightKg: 1_000, shipmentWeightKg: 3_000 },
  piece: {
    overweightMinor: 39_500,
    overweightKg: 70,
    oversizeMinor: 8_000,
    oversizeLongestCm: 100,
    oversizeSecondCm: 80,
    nonConveyableMinor: 8_000,
    nonConveyableMinKg: 25,
    nonConveyableMaxKg: 70,
  },
  restrictedDestination: {
    minor: 11_900,
    countries: ["CD", "CF", "IQ", "IR", "KP", "LY", "SO", "YE"],
  },
  elevatedRisk: {
    minor: 11_900,
    countries: [
      "AF", "BF", "CD", "HT", "IQ", "LB", "LY", "ML", "SD", "SO", "SY", "UA", "VE", "YE",
    ],
    israelSuspendedSince: "2026-09-25",
  },
  remoteArea: { perKgMinor: 200, minMinor: 9_500 },
  demand: [
    {
      from: "2026-10-01",
      to: "2027-02-05",
      minorPerKg: {
        CN_HK_MO: 0,
        ASIA: 0,
        OCEANIA: 170,
        EUROPE: 90,
        AMERICAS: 170,
        MENA: 0,
        ROW: 280,
      },
    },
  ],
  // DHL's destination lists (anything else is "Rest of the World"); the US and its territories are
  // in the Americas.
  demandRegions: {
    CN_HK_MO: ["CN", "HK", "MO"],
    ASIA: [
      "BD", "BN", "BT", "ID", "IN", "JP", "KH", "KR", "LA", "LK", "MM", "MN", "MV", "MY", "NP", "PH",
      "PK", "SG", "TH", "TL", "TW", "VN",
    ],
    OCEANIA: [
      "AU", "CK", "FJ", "KI", "NC", "NR", "NU", "NZ", "PF", "PG", "SB", "TO", "TV", "VU", "WS",
    ],
    EUROPE: [
      "AD", "AL", "AT", "BA", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB",
      "GG", "GI", "GR", "HR", "HU", "IE", "IL", "IS", "IT", "JE", "LI", "LT", "LU", "LV", "MC", "MD",
      "ME", "MK", "MT", "NL", "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK", "SM", "TR", "VA",
    ],
    AMERICAS: [
      "AG", "AI", "AR", "AS", "AW", "BB", "BL", "BM", "BO", "BQ", "BR", "BS", "BZ", "CA", "CL", "CO",
      "CR", "CW", "DM", "DO", "EC", "FM", "GD", "GF", "GP", "GT", "GU", "GY", "HN", "HT", "JM", "KN",
      "KY", "LC", "MH", "MP", "MQ", "MS", "MX", "NI", "PA", "PE", "PR", "PW", "PY", "SR", "SV", "SX",
      "TC", "TT", "US", "UY", "VC", "VG", "VI",
    ],
    MENA: ["AE", "BH", "DZ", "EG", "JO", "KW", "LB", "MA", "OM", "QA", "SA", "TN"],
  },
  fuel: { minPct: 23, maxPct: 56.25 },
  exportDeclaration: { minor: 11_000, plusVat: true },
  insurance: { ratePct: 1, minMinor: 4_500 },
};
