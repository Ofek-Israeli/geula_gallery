/**
 * The hand-curated demo catalog (spec §8.3). `fetch-demo-images.ts` merges it with the AIC
 * metadata and the processed images into `data/demo-manifest.json`; the catalog seed reads only
 * the manifest. Medium and surface are curated by hand (14310 is oil on board), "Attributed to" is
 * kept for 186427, alt texts are written for this project in Hebrew and English (never copied from
 * AIC), and dimensions are the curated table values (cross-checked against AIC's first
 * `dimensions` segment by the fetch script).
 */

export type DemoMedium = "OIL" | "WATERCOLOR";
export type DemoSurface = "CANVAS" | "BOARD" | "CARDBOARD" | "PAPER";
export type DemoStatus = "AVAILABLE" | "ON_HOLD" | "SOLD" | "NOT_FOR_SALE";

export interface DemoSeries {
  slug: string;
  name: { he: string; en: string };
}

export const DEMO_SERIES: readonly DemoSeries[] = [
  { slug: "landscapes", name: { he: "נופים", en: "Landscapes" } },
  { slug: "abstractions", name: { he: "הפשטות", en: "Abstractions" } },
  {
    slug: "interiors-still-life",
    name: { he: "פנים וטבע דומם", en: "Interiors & Still Life" },
  },
  { slug: "shoreline", name: { he: "קו החוף", en: "Shoreline" } },
  {
    slug: "works-on-paper",
    name: { he: "עבודות על נייר", en: "Works on Paper" },
  },
];

export interface DemoWork {
  aicId: number;
  imageId: string;
  slug: string;
  title: { en: string; he: string };
  artist: { en: string; he: string };
  date: { en: string; he: string };
  yearCreated: number;
  medium: DemoMedium;
  surface: DemoSurface;
  mediumDetail: { en: string; he: string };
  heightMm: number;
  widthMm: number;
  series: string;
  status: DemoStatus;
  holdReason?: "RESERVED_OFFLINE";
  /** Whole shekels / dollars (the seed converts to minor units). */
  priceIls: number | null;
  priceUsd: number | null;
  canBeRolled?: boolean;
  crate?: boolean;
  quoteOnly?: boolean;
  /** "ILS only" in the §8.3 table: a domestic-only listing (no USD price, no shipping abroad). */
  domesticOnly?: boolean;
  featured?: boolean;
  alt: { he: string; en: string };
  /** Where the sold works come from (spec §8.4 sample orders 1–3). */
  sampleOrder?: 1 | 2 | 3;
}

const OIL_CANVAS = { en: "Oil on canvas", he: "שמן על בד" };
const OIL_COMPOSITION_BOARD = {
  en: "Oil on composition board",
  he: "שמן על לוח דחוס",
};

export const DEMO_WORKS: readonly DemoWork[] = [
  {
    aicId: 65912,
    imageId: "d9b07617-7953-5ef1-6a0f-1f593baf06a1",
    slug: "landscape-no-26",
    title: { en: "Landscape no. 26", he: "נוף מס׳ 26" },
    artist: { en: "Marsden Hartley", he: "מרסדן הארטלי" },
    date: { en: "1909–10", he: "1909–1910" },
    yearCreated: 1909,
    medium: "OIL",
    surface: "CARDBOARD",
    mediumDetail: { en: "Oil on cardboard", he: "שמן על קרטון" },
    heightMm: 305,
    widthMm: 305,
    series: "landscapes",
    status: "AVAILABLE",
    priceIls: 3200,
    priceUsd: 870,
    alt: {
      he: "נוף הררי בצבעי סתיו עזים: גבעות אדומות וכחולות, יער בכתום ובצהוב וסלעים לבנים בחזית, מתחת לשמיים כחולים עם עננים לבנים.",
      en: "A hilly landscape in strong autumn colours: red and blue hills, a forest in orange and yellow and white rocks in front, under a blue sky with white clouds.",
    },
  },
  {
    aicId: 90207,
    imageId: "768387ba-f972-b43b-39f7-98cb37dad883",
    slug: "movement-no-10",
    title: { en: "Movement No. 10", he: "תנועה מס׳ 10" },
    artist: { en: "Marsden Hartley", he: "מרסדן הארטלי" },
    date: { en: "1917", he: "1917" },
    yearCreated: 1917,
    medium: "OIL",
    surface: "BOARD",
    mediumDetail: OIL_COMPOSITION_BOARD,
    heightMm: 387,
    widthMm: 495,
    series: "abstractions",
    status: "AVAILABLE",
    priceIls: 5800,
    priceUsd: 1550,
    alt: {
      he: "טבע דומם בצורות גיאומטריות: אגס, בננה ומפית לבנה מקופלת על צלחת עגולה כהה, על רקע אפור.",
      en: "A geometric still life: a pear, a banana and a folded white napkin on a dark round plate, against a grey background.",
    },
  },
  {
    aicId: 94241,
    imageId: "e4df4d4a-4cfb-5be8-3728-0d0bf1b44751",
    slug: "the-red-room-etretat",
    title: { en: "The Red Room, Etretat", he: "החדר האדום, אטרטה" },
    artist: { en: "Félix Edouard Vallotton", he: "פליקס אדואר ואלוטון" },
    date: { en: "1899", he: "1899" },
    yearCreated: 1899,
    medium: "OIL",
    surface: "BOARD",
    mediumDetail: { en: "Oil on artist's board", he: "שמן על לוח ציור" },
    heightMm: 492,
    widthMm: 513,
    series: "interiors-still-life",
    status: "SOLD",
    priceIls: 7400,
    priceUsd: null,
    sampleOrder: 1,
    alt: {
      he: "חדר עם קירות אדומים: אישה בשמלה בורדו יושבת בכורסה ליד אח, ותינוקת בשמלה ורודה משחקת על השטיח.",
      en: "A room with red walls: a woman in a burgundy dress sits in an armchair by a fireplace while a toddler in a pink dress plays on the rug.",
    },
  },
  {
    aicId: 14310,
    imageId: "9678901a-7c1e-a9ed-aa9a-5b208fe9a80e",
    slug: "still-life-green-flower-vase",
    title: {
      en: "Still-Life with a Green Flower Vase",
      he: "טבע דומם עם אגרטל פרחים ירוק",
    },
    artist: { en: "Paula Modersohn-Becker", he: "פאולה מודרזון-בקר" },
    date: { en: "c. 1902", he: "בסביבות 1902" },
    yearCreated: 1902,
    medium: "OIL",
    surface: "BOARD",
    mediumDetail: { en: "Oil on wood pulp board", he: "שמן על לוח עיסת עץ" },
    heightMm: 377,
    widthMm: 291,
    series: "interiors-still-life",
    status: "AVAILABLE",
    priceIls: 4600,
    priceUsd: 1250,
    alt: {
      he: "אגרטל ירוק מלא פרחים בלבן, ורוד, כתום ובורדו, על מפה בעלת דוגמה מסולסלת, על רקע כחול־אפור.",
      en: "A green vase full of white, pink, orange and burgundy flowers on a cloth with a curling pattern, against a blue-grey background.",
    },
  },
  {
    aicId: 256797,
    imageId: "6744270e-1f05-e07c-18a9-ea06f180a8fb",
    slug: "at-the-rivers-bend",
    title: { en: "At the River's Bend", he: "בעיקול הנהר" },
    artist: { en: "Lilla Cabot Perry", he: "לילה קבוט פרי" },
    date: { en: "1895", he: "1895" },
    yearCreated: 1895,
    medium: "OIL",
    surface: "CANVAS",
    mediumDetail: OIL_CANVAS,
    heightMm: 655,
    widthMm: 815,
    series: "landscapes",
    status: "AVAILABLE",
    priceIls: 9800,
    priceUsd: 2650,
    featured: true,
    alt: {
      he: "דיוקן נערה בעלת שיער חום ארוך בחולצה ורודה בהירה, יושבת על גדת נהר שמשתקפים בו עצים ירוקים כהים.",
      en: "A portrait of a girl with long brown hair in a pale pink blouse, sitting on a riverbank that reflects dark green trees.",
    },
  },
  {
    aicId: 100476,
    imageId: "16e53257-ade2-4f5d-3521-2bc9666bc4cf",
    slug: "beach-at-cabasson",
    title: { en: "Beach at Cabasson (Baigne-Cul)", he: "החוף בקבאסון" },
    artist: { en: "Henri Edmond Cross", he: "אנרי אדמון קרוס" },
    date: { en: "1891–92", he: "1891–1892" },
    yearCreated: 1891,
    medium: "OIL",
    surface: "CANVAS",
    mediumDetail: OIL_CANVAS,
    heightMm: 653,
    widthMm: 923,
    series: "shoreline",
    status: "AVAILABLE",
    priceIls: 12500,
    priceUsd: 3400,
    featured: true,
    alt: {
      he: "חוף ים מואר בנקודות צבע: שלושה ילדים משחקים בחול הלבן, סלעים כתומים יורדים אל ים כחול־סגול ומשמאל לפינה ענף עץ.",
      en: "A sunlit beach painted in dots of colour: three boys play on the white sand, orange rocks run into a blue-violet sea, and a tree branch reaches in from the corner.",
    },
  },
  {
    aicId: 212300,
    imageId: "ef637785-df55-adaf-b907-e3e8f59f08d6",
    slug: "beach-les-grands-sables",
    title: {
      en: "The Beach of Les Grands Sables at Le Pouldu",
      he: "חוף לה גראן סאבל",
    },
    artist: { en: "Paul Sérusier", he: "פול סרוזייה" },
    date: { en: "1890", he: "1890" },
    yearCreated: 1890,
    medium: "OIL",
    surface: "CANVAS",
    mediumDetail: OIL_CANVAS,
    heightMm: 600,
    widthMm: 700,
    series: "shoreline",
    status: "AVAILABLE",
    priceIls: 8900,
    priceUsd: null,
    domesticOnly: true,
    alt: {
      he: "שדה חיטה צהוב משתפל, דמות בודדת הולכת בו, ערמות שחת אדומות בפינה, ושורת עצים ובתים מתחת לשמיים ירקרקים.",
      en: "A sloping yellow wheat field with a lone walking figure, red haystacks in the corner, and a row of trees and houses under a greenish sky.",
    },
  },
  {
    aicId: 121377,
    imageId: "56a4af78-1d23-3e2a-6119-8aa47e0cf285",
    slug: "boats-at-rest",
    title: { en: "Boats at Rest", he: "סירות במנוחה" },
    artist: { en: "Arthur Wesley Dow", he: "ארתור ווסלי דאו" },
    date: { en: "c. 1895", he: "בסביבות 1895" },
    yearCreated: 1895,
    medium: "OIL",
    surface: "CANVAS",
    mediumDetail: OIL_CANVAS,
    heightMm: 660,
    widthMm: 914,
    series: "shoreline",
    status: "ON_HOLD",
    holdReason: "RESERVED_OFFLINE",
    priceIls: 11800,
    priceUsd: null,
    alt: {
      he: "סירת משוטים כחולה ולצידה סירה ירוקה קטנה עגונות על גדה עשבונית, ליד מפרץ שקט שבו משתקפים בתים.",
      en: "A blue rowing boat and a small green boat beached on a grassy bank beside a calm inlet that reflects houses.",
    },
  },
  {
    aicId: 72801,
    imageId: "3ae75415-0551-ae17-c478-3b8687a6f246",
    slug: "icebound",
    title: { en: "Icebound", he: "לכוד בקרח" },
    artist: { en: "John Henry Twachtman", he: "ג׳ון הנרי טוואכטמן" },
    date: { en: "c. 1889", he: "בסביבות 1889" },
    yearCreated: 1889,
    medium: "OIL",
    surface: "CANVAS",
    mediumDetail: OIL_CANVAS,
    heightMm: 642,
    widthMm: 766,
    series: "landscapes",
    status: "AVAILABLE",
    priceIls: 9200,
    priceUsd: 2450,
    canBeRolled: true,
    alt: {
      he: "נחל זורם בין גדות מכוסות שלג, עם מים בגוני טורקיז, סלעים אפורים ועצים דקים בעלים כתומים.",
      en: "A stream running between snow-covered banks, with turquoise water, grey rocks and slender trees with orange leaves.",
    },
  },
  {
    aicId: 64754,
    imageId: "4425984b-e241-6413-1404-cdac0fb06518",
    slug: "moonrise",
    title: { en: "Moonrise", he: "זריחת הירח" },
    artist: { en: "George Inness", he: "ג׳ורג׳ איננס" },
    date: { en: "1891", he: "1891" },
    yearCreated: 1891,
    medium: "OIL",
    surface: "CANVAS",
    mediumDetail: OIL_CANVAS,
    heightMm: 765,
    widthMm: 641,
    series: "landscapes",
    status: "SOLD",
    priceIls: 10400,
    priceUsd: 2800,
    sampleOrder: 2,
    alt: {
      he: "שעת דמדומים: ירח כתום עולה בשמיים חומים־ערפיליים, עץ כהה משמאל ודמות קטנה עומדת בשדה.",
      en: "Dusk: an orange moon rises in a hazy brown sky, with a dark tree on the left and a small figure standing in a field.",
    },
  },
  {
    aicId: 109693,
    imageId: "c7686c63-3aca-64b6-6710-02f34ccd0767",
    slug: "banks-of-the-durance",
    title: {
      en: "The Banks of the River Durance at Saint Paul",
      he: "גדות הדוראנס",
    },
    artist: { en: "Paul Camille Guigou", he: "פול קמי גיגו" },
    date: { en: "1864", he: "1864" },
    yearCreated: 1864,
    medium: "OIL",
    surface: "CANVAS",
    mediumDetail: OIL_CANVAS,
    heightMm: 620,
    widthMm: 1480,
    series: "landscapes",
    status: "AVAILABLE",
    priceIls: 18000,
    priceUsd: 4850,
    crate: true,
    quoteOnly: true,
    alt: {
      he: "נוף פנורמי רחב של נהר שקט, גדה חולית בהירה וצוק ירוק תחת שמיים תכולים עם ענן לבן.",
      en: "A wide panoramic view of a calm river, a pale sandy bank and a green cliff under a light blue sky with a white cloud.",
    },
  },
  {
    aicId: 71573,
    imageId: "a67c4473-57a4-9807-a94e-1136d3daf876",
    slug: "a-holiday",
    title: { en: "A Holiday", he: "יום חופש" },
    artist: { en: "Edward Henry Potthast", he: "אדוארד הנרי פוטהאסט" },
    date: { en: "c. 1915", he: "בסביבות 1915" },
    yearCreated: 1915,
    medium: "OIL",
    surface: "CANVAS",
    mediumDetail: OIL_CANVAS,
    heightMm: 764,
    widthMm: 1018,
    series: "shoreline",
    status: "AVAILABLE",
    priceIls: 14500,
    priceUsd: 3900,
    alt: {
      he: "ילדים בבגדים לבנים משתכשכים במים הרדודים בחוף, ומאחוריהם גלים מתנפצים בים כחול.",
      en: "Children in white clothes paddle in the shallow water at the beach, with waves breaking in a blue sea behind them.",
    },
  },
  {
    aicId: 186427,
    imageId: "4457ef17-3808-b015-5deb-ad8a961eb970",
    slug: "antibes",
    title: { en: "Antibes", he: "אנטיב" },
    artist: {
      en: "Attributed to Henri Edmond Cross",
      he: "מיוחס לאנרי אדמון קרוס",
    },
    date: { en: "1907", he: "1907" },
    yearCreated: 1907,
    medium: "WATERCOLOR",
    surface: "PAPER",
    mediumDetail: {
      en: "Watercolor with black chalk on paper",
      he: "צבעי מים וגיר שחור על נייר",
    },
    heightMm: 420,
    widthMm: 317,
    series: "works-on-paper",
    status: "AVAILABLE",
    priceIls: 1900,
    priceUsd: 520,
    alt: {
      he: "צבעי מים: עצי ברוש ועצי זית בכחול ובירוק בנקודות צבע, ומעבר למים עיר עם בתים אדומים.",
      en: "Watercolour: cypress and olive trees in blue and green dabs of colour, with a town of red buildings across the water.",
    },
  },
  {
    aicId: 30928,
    imageId: "7182fe78-c4dd-c30d-2ae7-d1e018aacfd8",
    slug: "terrace-bridge-central-park",
    title: { en: "The Terrace Bridge, Central Park", he: "גשר הטרסה" },
    artist: { en: "Maurice Prendergast", he: "מוריס פרנדרגאסט" },
    date: { en: "1901", he: "1901" },
    yearCreated: 1901,
    medium: "WATERCOLOR",
    surface: "PAPER",
    mediumDetail: {
      en: "Watercolor over graphite on paper",
      he: "צבעי מים על רישום עיפרון, על נייר",
    },
    heightMm: 388,
    widthMm: 569,
    series: "works-on-paper",
    status: "SOLD",
    priceIls: 2600,
    priceUsd: null,
    sampleOrder: 3,
    alt: {
      he: "צבעי מים: המון אנשים בבגדים צבעוניים ובשמשיות יורדים במדרגות אבן רחבות בפארק, מוקפים עצים.",
      en: "Watercolour: a crowd of people in colourful clothes with parasols walking down wide stone steps in a park, surrounded by trees.",
    },
  },
  {
    aicId: 270002,
    imageId: "15a0f792-0c21-406e-3e4d-ac8c2393c873",
    slug: "interior-music-room",
    title: {
      en: "Interior. The Music Room, Strandgade 30",
      he: "פנים. חדר המוזיקה",
    },
    artist: { en: "Vilhelm Hammershøi", he: "וילהלם המרסהוי" },
    date: { en: "1907", he: "1907" },
    yearCreated: 1907,
    medium: "OIL",
    surface: "CANVAS",
    mediumDetail: OIL_CANVAS,
    heightMm: 700,
    widthMm: 590,
    series: "interiors-still-life",
    status: "NOT_FOR_SALE",
    priceIls: null,
    priceUsd: null,
    alt: {
      he: "חדר שקט בגוני אפור: פסנתר עתיק, כיסא לבן וצ׳לו נשען על הקיר, מתחת לתמונה ממוסגרת.",
      en: "A quiet room in shades of grey: an old piano, a white chair and a cello leaning on the wall below a framed picture.",
    },
  },
  {
    aicId: 65930,
    imageId: "2a328b12-cb68-19e8-3843-b2160f007813",
    slug: "still-life-no-15",
    title: { en: "Still Life No. 15", he: "טבע דומם מס׳ 15" },
    artist: { en: "Marsden Hartley", he: "מרסדן הארטלי" },
    date: { en: "c. 1917", he: "בסביבות 1917" },
    yearCreated: 1917,
    medium: "OIL",
    surface: "BOARD",
    mediumDetail: OIL_COMPOSITION_BOARD,
    heightMm: 594,
    widthMm: 495,
    series: "interiors-still-life",
    status: "AVAILABLE",
    priceIls: 6900,
    priceUsd: 1850,
    alt: {
      he: "טבע דומם: גביע לבן עם עיטור כחול ובו פרח ורוד אחד, על רקע בדים בצהוב ובכחול ורקע שחור.",
      en: "A still life: a white goblet with blue decoration holding one pink flower, set against draped yellow and blue cloth on a black background.",
    },
  },
];

/** The two images the IIIF server must serve at a different size (spec §8.2). */
export function iiifUrl(work: Pick<DemoWork, "aicId" | "imageId">): string {
  const size = work.aicId === 270002 ? "!2000,2000" : "1686,";
  return `https://www.artic.edu/iiif/2/${work.imageId}/full/${size}/0/default.jpg`;
}

/** The honest demo description (spec §8.3). */
export function demoDescription(work: DemoWork): { en: string; he: string } {
  return {
    en: `Demo listing using a public-domain painting by ${work.artist.en} (${work.date.en}), The Art Institute of Chicago (CC0). This is a placeholder for the painter's own work; it is not for sale, and checkout accepts test payments only.`,
    he: `רישום הדגמה המשתמש בציור ברשות הציבור מאת ${work.artist.he} (${work.date.he}), מכון האמנות של שיקגו (CC0). זהו ממלא מקום ליצירות של האמנית; הציור אינו מוצע למכירה, והקופה מקבלת תשלומי בדיקה בלבד.`,
  };
}
