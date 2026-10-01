# מדריך לאמנית – גלריה גאולה / Painter onboarding

> המסמך כתוב קודם בעברית, ואחריו גרסה מלאה באנגלית. כל הטקסטים המשפטיים באתר הם **טיוטות**
> שדורשות אישור עורך דין, וכל ההגדרות החשבונאיות דורשות אישור רואה חשבון. אין במסמך הזה ייעוץ
> משפטי או מס.
>
> The Hebrew version comes first; the full English version follows it.

---

## 1. החלטות של האמנית
- שם משפטי ושם מסחרי; האם מספר הזהות/העוסק יופיע במסמכים. הוא מופיע רק בקופה (דף שלא נסרק
  במנועי חיפוש), במסמך הגילוי, בקבלות ובמיילים – לעולם לא בדפים המשפטיים או בתחתית האתר.
- כתובת עסקית לפרסום וכתובת להחזרות; טלפונים (כולל וואטסאפ).
- מחירים בשקלים ובדולרים; תשלומים (ברירת מחדל: תשלום אחד).
- הצעות מחיר מקונים (מופעל/כבוי) וסף לדחייה אוטומטית.
- משך שמירת יצירה בזמן תשלום (35 דקות) ובקישור תשלום (48 שעות); איסוף עצמי ומסירה אישית.
- אילו יצירות אפשר לגלגל לשפופרת; מסגור וזכוכית.
- ביטוח משלוחים (DHL או צד שלישי) ואישור הכיסוי בכתב.
- כיול תעריפי המשלוח; פתיחת אירופה ובריטניה.
- מדיניות דמי ביטול (עד המקסימום שהחוק מתיר, או בלי דמי ביטול) – הגדרות ← ביטול עסקה.
- מתי להחליף את תמונות ההדגמה ביצירות שלך.

## 2. שאלות לספקים

### Cardcom (סליקה ראשית)
- **מסוף בדיקות אמיתי**: מסוף הבדיקות הציבורי כבר לא מקבל את הפרטים המפורסמים – כל בקשה
  נדחית ב-HTTP 401 עם ResponseCode 603 ("שם משתמש או סיסמה שגויים"). צריך לבקש מ-Cardcom
  **מספר מסוף בדיקות ו-ApiName משלך** (ואם אפשר גם ApiPassword למסוף הבדיקות), וכרטיסי בדיקה.
- עמלות סליקה; עמלה על כרטיסים מחו״ל.
- **מסוף דולרי** (USD) – האם המסוף מקבל דולרים, ובאיזה שער מתבצעת ההמרה.
- **תשלומים**: האם מותר, כמה, ומי נושא בריבית.
- **J5 (אישור מסגרת וחיוב מאוחר)**: כמה זמן ההחזקה תקפה (עתידי; היום החיוב מיידי).
- משך החיים של דף תשלום LowProfile.
- **ApiPassword** – נדרש להחזרים אוטומטיים ולסריקה היומית של העסקאות. בלעדיו כל החזר הופך
  ל"דורש החזר ידני".
- מודול מסמכים (קבלות של Cardcom) – אם רואה החשבון יבחר במצב gateway.
- ארנקים: Bit, Apple Pay, Google Pay – מה מופעל במסוף, ומהי **תקרת הסכום ב-Bit** לעסקה אחת.
- **התנהגות ה-webhook**: האם יש ניסיונות חוזרים ובאיזה קצב, מאילו כתובות IP, האם הגוף הוא JSON,
  והאם מותרת כתובת localhost בסביבת בדיקות.
- קודי התשובה בהחזרים (מה נחשב הצלחה וכשל).

### PayPal (סליקה משנית, לקונים מחו״ל)
- חשבון עסקי שמקבל דולרים.
- אפליקציית **sandbox** (Client ID ו-Secret) לבדיקות, ואחר כך אפליקציית **live**.
- מזהה סוחר (Merchant ID) – האתר דוחה תשלום שהגיע לחשבון אחר.
- כתובת webhook ומזהה ה-webhook (ראו `docs/deploy.md` §7).

### Morning (חשבונית ירוקה)
- המסלול (נדרש מסלול עם גישת API) ומפתחות API ל-sandbox ולייצור.

### DHL Express ישראל
- **חשבון DHL** ומפתחות MyDHL API (בדיקות וייצור).
- תקרת ערך למשלוח אמנות; האם יצירות מקוריות מותרות לכל יעד.
- ביטוח ו-Shipment Value Protection; קוד השירות WY.
- **הצהרת יצוא** ו**ייפוי כוח** לעמיל המכס; מי מגיש מעל 200$.
- האם **עוסק פטור** יכול לפתוח חשבון ולשלוח בייצוא.
- ביטול תוויות שהופקו; DDP (תשלום מכס מראש – עתידי).

### Resend (מיילים)
- אימות הדומיין (רשומות SPF, DKIM, DMARC); אזור eu-west-1. נתוני החשבון נשמרים בארה״ב.

## 3. רשימת בדיקה לרואה החשבון
- עוסק פטור או מורשה (תקרת 2026: ‎122,833 ₪; כמה מכירות עלולות לחצות אותה).
- סוגי מסמכים 400 / 320 / 330, ואיך עוסק פטור מתעד החזר.
- **האם להפיק קבלה וזיכוי גם לתשלומים שהוחזרו** (יצירה שכבר נמכרה, תשלום כפול, הצעת מחיר
  שהשתנתה). ההגדרה `receiptForRefundedPayments` מופעלת כברירת מחדל (הגדרות ← קופה ותשלומים).
- מערכת מסמכים אחת (Morning) או מסמכי Cardcom (gateway); קבלות על תשלומי PayPal.
- יצוא בשיעור אפס: vatType, ראיות להצהרת יצוא מעל 200$ ומתי להגיש, ותמחור.
- רישום דולרים בספרים בשקלים.
- מספרי הקצאה: רק לחשבונית מס של עוסק מורשה מעל ‎5,000 ₪ לפני מע״מ, לעסק רשום (מאז 1.6.2026).
  לכן יש בקופה שדות רשות לשם חברה ומספר עוסק.
- סעיף 18ב; מספור החשבונית המסחרית לעומת מסמכי המס; שמירה 7 שנים.

## 4. רשימת בדיקה לעורך הדין
- **נוסחים**: תנאי מכירה, ביטולים והחזרות, משלוחים ומכס, פרטיות, הצהרת נגישות; מסמך הגילוי
  (דף HTML, תקציר במייל, PDF מצורף ועותק מודפס באריזה); שלט לסטודיו (סעיף 4ג); תעודת מקוריות.
- **טופס הביטול**:
  - האם שלב 1 של הטופס המקוון כבר נחשב הודעת ביטול;
  - טופס יחיד: שם ותעודת זהות/דרכון **או** מספר הזמנה, דוא״ל רשות; אישור דו-שלבי כנהוג באירופה;
  - האם מותר לעכב החזר עד שהיצירה חוזרת; מי משלם את משלוח ההחזרה;
  - בסיס חישוב דמי הביטול והמרתם לדולרים (כיום: 5% מהסכום ששולם, עד ‎100 ₪, בשער הנעול);
  - **האם שאלה או שיחה לפני הרכישה נחשבת "שיחה"** (ברירת מחדל: כן, מזוהה אוטומטית), וברירת
    המחדל להעניק 4 חודשים כשהוצהרה זכאות;
  - חלון הביטול נספר עד סוף היום ה-14 (שעון ישראל); מועד ההחזר – 14 ימים מקבלת ההודעה;
  - משלוח אחרי הודעת ביטול פתוחה (חסום כברירת מחדל, עם עקיפה מנומקת);
  - נוסחי דחייה וסייג סעיף 2(ב2).
- **מחירים**: הצגת מחיר במטבע חוץ (סעיף 17ז(א)(1)); פרטי הסוחר לפי Visa; ניסוח "מבוטח".
- **חוצה גבולות ומידע**: GPSR ומכירה לאיחוד האירופי וטופס הביטול האירופי; משלוחים בערך נמוך
  לבריטניה; רשימת המדינות החסומות (עיראק? תימן?); הצגת מספר הזהות והכתובת העסקית; ספקי עיבוד
  והעברה לארה״ב; תקופות השמירה.
- **זכויות**: זכויות יוצרים וזכות מוסרית (תעודת מקוריות: סעיפים 37(ג) ו-45(ב) – לבדיקה); הסכמה
  לנתוני מעקב DHL; שימוש בתמונות ההדגמה של מכון האמנות של שיקגו (CC0).

## 5. סיור בהגדרות
- **הגדרות ← פרטי העסק ומע״מ**: שם, כתובות, טלפונים, מספר עוסק, מצב מע״מ. עד שמסמנים "הפרטים
  מלאים ומעודכנים", תשלומים אמיתיים חסומים.
- **הגדרות ← קופה ותשלומים**: זמני שמירה, מגבלות נגד "תפיסת" יצירות, שער הדולר, מספר תשלומים
  מקסימלי, האם להציע PayPal גם ליעדים בישראל, וקבלה לתשלומים שהוחזרו.
- **הגדרות ← משלוחים**: אזורים, תעריף בסיס לפי גודל, תוספות (דלק, עונה), ביטוח ותקרת שווי מבוטח,
  תקרת שווי מוצהר לפי מוביל, מדינות, ספים (הצהרת יצוא), איסוף עצמי, מסירה על ידי האמנית, שליח
  בארץ. אחרי בדיקת התעריפים – "סימון: התעריפים כוילו היום".
- **הגדרות ← ביטול עסקה**: דמי הביטול המוצעים (הצעה בלבד – בכל ביטול אפשר רק להפחית).
- **חשבון**: סיסמה ואימות דו-שלבי (חובה באתר החי).
- בלוח הבקרה מופיעה רשימת "מוכנות לעלייה לאוויר": כל עוד יש בה פריט פתוח, תשלומים אמיתיים חסומים.

## 6. איך עושים…

### לטפל בהודעת ביטול
1. ההודעה מופיעה ב**ביטולים**, ממוינת לפי מועד ההחזר. מספר הזהות מוצג רק חלקית.
2. אם לא שויכה להזמנה – מזינים את מספר ההזמנה ולוחצים "שיוך להזמנה".
3. הודעה כפולה (אותו אדם שלח פעמיים, או גם התקשר) – "סגירה ככפילות" עם מספר ההודעה המקורית.
4. בודקים: חלון הביטול, מקור השיחה, דמי הביטול המוצעים.
5. **אישור הביטול**: אם היצירה לא נשלחה – המשלוח מבוטל וההחזר יוצא מיד. אם נשלחה – נשלחות
   הוראות החזרה; כשהיצירה מגיעה מסמנים "היצירה התקבלה בסטודיו", בודקים ("נבדקה – תקינה"), ואז "ביצוע ההחזר".
6. אחרי שההחזר הושלם: "סגירת הטיפול", ואז "החזרה למכירה" (או "סימון כלא למכירה (פגומה)").
7. הודעה שהתקבלה בטלפון, במייל או בדואר: **ביטולים ← רישום הודעת ביטול**, עם מועד הקבלה בפועל: 14 הימים להחזר נספרים ממנו.

### לאשר החזר "לא ידוע" או "נכשל"
נכנסים ללוח הבקרה של Cardcom או PayPal ומוצאים את העסקה לפי מספר ההזמנה. במסך ההזמנה:
- החזר **לא ידוע**: "בדיקה מול הספק"; אם עדיין לא ברור – "בדקתי בלוח הבקרה: ההחזר בוצע" או
  "…ההחזר לא בוצע".
- החזר **שנכשל**: "בדקתי בלוח הבקרה של הספק: לא הוחזר כסף", ואז "ניסיון חוזר". עד האישור הזה
  ההחזר שנכשל נספר בתקרת ההחזרים, כדי שלא יוחזר כסף פעמיים.

### להדפיס
- מסמך גילוי – מהקישור במייל אישור ההזמנה או מעמוד ההזמנה; חובה לצרף ליצירה.
- תעודת משלוח וחשבונית מסחרית – ממסך "הכנה למשלוח".
- שלט לסטודיו (סעיף 4ג): `/he/print/admin/studio-notice`.
- תעודת מקוריות: `/he/print/admin/coa/<מזהה מכירה>`.

## 7. ספר הפעלה (runbook)

| מצב | מה עושים |
|---|---|
| **תשלום תקוע** ("ממתין", "בבדיקה" או "בחיוב") | במסך ההזמנה לוחצים "בדיקת תשלום מחדש". המערכת שואלת את הספק ומחליטה; אין צורך לחייב שוב. אם התשלום בבדיקה אצל PayPal, ההחלטה מגיעה מ-PayPal. אחרי 24 שעות תתקבל התראה. |
| **תשלום נדחה** (deferred) | ניסיון תשלום אחר על אותה הזמנה נמצא בתהליך; המערכת מכריעה תוך 15 דקות. אם שני התשלומים הצליחו, הכפול מוחזר אוטומטית. |
| **החזר ידני** ("דורש החזר ידני") | מחזירים את הכסף בלוח הבקרה של הספק או בהעברה בנקאית, ואז "סימון כהוחזר ידנית" עם אסמכתה. שימו לב למועד ההחזר שמופיע ליד ההחזר. |
| **תווית במצב לא ידוע** (LABEL_UNKNOWN) | בודקים ב-MyDHL אם נוצרה תווית להזמנה. אם כן – "התווית קיימת" עם מספר שטר המטען. אם לא – "וידאתי שאין תווית – לחזור לאריזה" ומפיקים שוב. לעולם לא מפיקים שוב לפני הבדיקה (אחרת ייתכנו שתי תוויות בתשלום). |
| **מסמך חשבונאי לא ידוע / דורש הפקה ידנית** | המערכת מחפשת את המסמך ב-Morning לפי הסימון (למשל `GG-XXXXXX/RECEIPT/1`) שלוש פעמים. אם לא הוכרע: מחפשים ב-Morning בעצמכם. אם המסמך קיים – "רישום מסמך שהופק ידנית" עם מספרו; אם לא – "הפקה מחדש". |
| **משימה שנכשלה סופית** (DEAD) | **התראות ← משימות שנכשלו סופית**: קוראים את השגיאה, מתקנים את הסיבה (למשל מפתח API שפג), ואז "הרצה מחדש". המשימות בטוחות להרצה חוזרת. |
| **עסקת Cardcom לא מזוהה** | התראה קריטית מהסריקה היומית: יש בכרטיסים כסף שהמערכת לא יודעת לשייך. מוצאים את העסקה בלוח הבקרה של Cardcom (סכום, תאריך, 4 ספרות). אם היא שייכת להזמנה – פותחים את ההזמנה ולוחצים "בדיקת תשלום מחדש"; אם לא – מחזירים את הכסף ב-Cardcom ומתעדים. |
| **מחלוקת או ביטול חיוב ב-PayPal** | ההזמנה נחסמת למשלוח והתראה קריטית נשלחת. עונים על המחלוקת בתוך PayPal. |
| **דליפת סוד** (מפתח, סיסמה) | 1. מחליפים את המפתח **אצל הספק** מיד (Cardcom, PayPal, Morning, DHL, Resend, Neon, Blob). 2. מעדכנים ב-Vercel ופורסים מחדש. 3. אם דלף `CRON_SECRET`, `APP_SECRET` או `BETTER_AUTH_SECRET` – מחליפים (כל המשתמשים יתנתקו). **לא** מחליפים את `PII_ENCRYPTION_KEY` בלי תוכנית: בלעדיו אי אפשר לקרוא מספרי זהות שמורים. 4. בודקים את ההיסטוריה: `git log -p --all --format= \| npm run check:secrets -- --stdin`. מחיקת היסטוריה לא מבטלת דליפה שכבר נדחפה – ההחלפה היא התיקון. |

---

# English version

> All legal texts on the site are **drafts** that need a lawyer's approval, and every accounting
> setting needs the accountant's approval. Nothing here is legal or tax advice.

## 1. The painter's decisions
- Legal and trade name, and whether the ID or business number appears on documents. It appears
  only at checkout (a noindex page), in the disclosure document, in receipts and in emails, and
  never on the legal pages or in the footer.
- A business address for publication and an address for returns; phones (including WhatsApp).
- Prices in ILS and USD; installments (default: a single payment).
- Offers from buyers on or off, and the auto-decline threshold.
- How long a work is held during payment (35 minutes) and on a payment link (48 hours); studio
  pickup and delivery by the artist.
- Which works can be rolled into a tube; framing and glazing.
- Shipping insurance (DHL or a third party) and written confirmation of the coverage.
- Shipping rate calibration; opening Europe and the UK.
- The cancellation fee policy (up to the legal maximum, or no fee): Settings → Cancellations.
- When to replace the demo images with your own works.

## 2. Questions for the providers

### Cardcom (primary card processor)
- **A real test terminal.** The public test terminal no longer accepts its published
  credentials: every request is refused with HTTP 401 and ResponseCode 603 ("wrong user name or
  password"). Ask Cardcom for **your own test terminal number and ApiName**, ideally with an
  ApiPassword for the test terminal too, and for test card numbers.
- Processing fees, including the fee for foreign cards.
- **A USD terminal:** does the terminal accept USD, and at what conversion rate?
- **Installments:** allowed or not, how many, and who pays the interest.
- **J5 (authorise now, charge later):** how long the authorisation holds (future work; today
  payments are charged immediately).
- How long a LowProfile payment page stays valid.
- **ApiPassword:** needed for automatic refunds and for the daily transaction sweep. Without it,
  every refund becomes "Manual refund needed".
- The documents module (Cardcom receipts), in case the accountant chooses gateway mode.
- Wallets: Bit, Apple Pay, Google Pay. Which are enabled on the terminal, and the **Bit cap**
  (the largest amount Bit accepts in one transaction).
- **Webhook behaviour:** are notifications retried and how often, from which IP addresses, is
  the body JSON, and is a localhost URL allowed in test mode?
- Refund response codes: which codes mean success and which mean failure.

### PayPal (secondary processor, for buyers abroad)
- A business account that receives USD.
- A **sandbox** app (client id and secret) for testing, then a **live** app.
- The merchant id. The site refuses a payment that reached a different account.
- The webhook URL and webhook id (see `docs/deploy.md` §7).

### Morning (Green Invoice)
- The plan (it must include API access), and API keys for the sandbox and for production.

### DHL Express Israel
- **A DHL account** and MyDHL API keys (test and production).
- The value limit for shipping art; whether original works may go to every destination.
- Insurance and Shipment Value Protection; the WY service code.
- The **export declaration** and the **power of attorney** for the customs broker; who files
  above USD 200.
- Whether an **osek patur** (exempt dealer) can open an account and ship exports.
- Voiding labels that were already created; DDP (prepaid duties, future work).

### Resend (email)
- Domain verification (SPF, DKIM and DMARC records) in region eu-west-1. Account data is stored
  in the US.

## 3. Accountant checklist
- Osek patur or osek murshe (the 2026 ceiling is ₪122,833; a few sales can cross it).
- Document types 400, 320 and 330, and how an osek patur documents a refund.
- **Whether to issue a receipt and a credit note for payments that were refunded** because the
  work was already sold, the buyer paid twice, or the quote had changed. The setting
  `receiptForRefundedPayments` is on by default (Settings → Checkout and payments).
- One document system (Morning) or Cardcom gateway documents; receipts for PayPal payments.
- Zero-rated exports: `vatType`, export declaration evidence above USD 200 and when to file it,
  and pricing.
- Recording USD amounts in ILS books.
- Allocation numbers: only for an osek murshe's tax invoices above ₪5,000 before VAT, to a
  VAT-registered business buyer (since 2026-06-01). That is why checkout has optional company
  name and VAT number fields.
- Section 18B; the commercial invoice's numbering versus the tax documents; 7-year retention.

## 4. Lawyer checklist
- **Texts:** terms of sale, cancellations and returns, shipping and duties, privacy, the
  accessibility statement; the disclosure document (an HTML page, a summary in the email, an
  attached PDF and a printed copy in the parcel); the studio notice (s.4C); the certificate of
  authenticity.
- **The cancellation form:**
  - whether step 1 of the online form already counts as notice;
  - the single form: name plus ID/passport **or** order number, email optional; the European
    two-step acknowledgement;
  - whether the refund may wait until the work is returned; who pays the return shipping;
  - the fee base and its USD conversion (today: 5% of the amount paid, at most ₪100, at the
    order's locked rate);
  - **whether a question or conversation before the purchase counts as a "conversation"**
    (default: yes, detected automatically), and the default of granting 4 months when
    eligibility is declared;
  - the cancellation window runs to the end of the 14th day (Israel time); the refund is due
    14 days after the notice is received;
  - shipping while a cancellation notice is open (blocked by default, with a reasoned override);
  - rejection templates and the s.2(b2) exception.
- **Pricing:** showing prices in a foreign currency (s.17G(a)(1)); Visa's merchant-disclosure
  details; the wording of "insured".
- **Cross-border and data:** GPSR, selling to the EU, and the EU model withdrawal form; UK
  low-value consignments; the list of blocked countries (Iraq? Yemen?); showing the ID number
  and the business address; processors and transfers to the US; retention periods.
- **Rights:** copyright and moral rights (certificate of authenticity: s.37(c) and s.45(b), to be
  checked); consent for DHL tracking data; use of the Art Institute of Chicago demo images (CC0).

## 5. Settings walkthrough
- **Settings → Business details and VAT:** name, addresses, phones, business number, VAT mode.
  Real payments stay blocked until you tick "The details are complete and current".
- **Settings → Checkout and payments:** hold times, anti-hoarding limits, the USD rate, the
  maximum number of installments, whether PayPal is offered for Israeli destinations too, and
  receipts for refunded payments.
- **Settings → Shipping:** zones, base rate by size, surcharges (fuel, season), insurance and the
  insured-value cap, the declared-value cap per carrier, countries, thresholds (export
  declaration), studio pickup, delivery by the artist, the domestic courier. After checking the
  rates, press "Mark the rates as calibrated today".
- **Settings → Cancellations:** the suggested cancellation fee. It is a suggestion only; for each
  cancellation you can only lower it.
- **Account:** password and two-step verification (required on the live site).
- The dashboard shows a "go-live readiness" list. While any item is open, real payments are
  blocked.

## 6. How to…

### Handle a cancellation notice
1. The notice appears under **Cancellations**, sorted by refund due date. The ID number is
   shown only partly.
2. If it was not matched to an order, enter the order number and press "Match to order".
3. A duplicate notice (the same person sent it twice, or also phoned): "Close as duplicate",
   with the number of the original notice.
4. Check the cancellation window, the conversation source and the suggested fee.
5. **Accept cancellation.** If the work was not shipped, the shipment is cancelled and the
   refund goes out at once. If it was shipped, return instructions are sent; when the work
   arrives, press "The work arrived at the studio", inspect it ("Inspected – fine"), then
   "Make the refund".
6. Once the refund is complete: "Close", then "Relist for sale" (or "Mark not for sale
   (damaged)").
7. A notice received by phone, email or post: **Cancellations → Log a notice**, with the actual
   time it was received; the 14 days for the refund count from it.

### Confirm an "unknown" or "failed" refund
Open the Cardcom or PayPal dashboard and find the transaction by order number. Then, on the
order page:
- An **unknown** refund: press "Check with the provider". If it is still unclear, press "I checked
  the dashboard: the refund went through" or "…no refund was made".
- A **failed** refund: press "I checked the provider dashboard: no money was refunded", then
  "Retry". Until you confirm, the failed refund counts against the refund cap, so money is never
  refunded twice.

### Print
- The disclosure document: from the link in the order confirmation email or from the order
  page. It must go in the parcel with the work.
- The packing slip and commercial invoice: from the fulfillment screen.
- The studio notice (s.4C): `/he/print/admin/studio-notice`.
- The certificate of authenticity: `/he/print/admin/coa/<sale id>`.

## 7. Runbook

| Situation | What to do |
|---|---|
| **Stuck payment** (pending, under review or capturing) | On the order page, press "Recheck payment". The system asks the provider and decides; never charge the buyer again. If PayPal is reviewing the payment, PayPal decides. An alert is raised after 24 hours. |
| **Deferred payment** | Another payment attempt on the same order is in progress; the system decides within 15 minutes. If both payments succeeded, the duplicate is refunded automatically. |
| **Manual refund** ("Manual refund needed") | Return the money in the provider's dashboard or by bank transfer, then "Mark refunded manually" with the reference. Watch the due date shown next to the refund. |
| **LABEL_UNKNOWN** (label status unknown) | Check in MyDHL whether a label exists for the order. If it does, choose "The label exists" and enter the waybill number. If not, choose "I checked: there is no label – back to packed" and create the label again. Never create a new label before checking, or you may pay for two. |
| **Tax document UNKNOWN or NEEDS_MANUAL** | The system searches Morning three times for the document by its marker (for example `GG-XXXXXX/RECEIPT/1`). If that is inconclusive, search Morning yourself. If the document exists, use "Record a document issued by hand" with its number; if not, use "Issue again". |
| **DEAD jobs** | **Alerts → Jobs that failed for good**: read the error, fix the cause (for example an expired API key), then "Run again". Jobs are safe to run again. |
| **Unmatched Cardcom transaction** | A CRITICAL alert from the daily sweep means the card account has money the system cannot place. Find the transaction in the Cardcom dashboard (amount, date, last 4 digits). If it belongs to an order, open the order and press "Recheck payment". If it does not, refund it in Cardcom and write down why. |
| **PayPal dispute or reversal** | The order is blocked from shipping and a CRITICAL alert is raised. Answer the dispute inside PayPal. |
| **Secret leak** (key or password) | 1. Rotate the key **at the provider** at once (Cardcom, PayPal, Morning, DHL, Resend, Neon, Blob). 2. Update it in Vercel and redeploy. 3. If `CRON_SECRET`, `APP_SECRET` or `BETTER_AUTH_SECRET` leaked, replace it; every user will be signed out. Do **not** replace `PII_ENCRYPTION_KEY` without a plan, because stored ID numbers cannot be read without it. 4. Check the history: `git log -p --all --format= \| npm run check:secrets -- --stdin`. Rewriting history does not undo a leak that was already pushed; rotation is the fix. |
