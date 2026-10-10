# מדריך לאמנית – האתר של גאולה לוי / Painter onboarding

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
- משך שמירת יצירה בזמן תשלום (35 דקות) ובקישור תשלום (48 שעות); איסוף עצמי.
- אילו יצירות אפשר לגלגל לשפופרת; מסגור וזכוכית.
- ביטוח משלוחים (DHL או צד שלישי) ואישור הכיסוי בכתב.
- כיול תעריפי המשלוח; פתיחת אירופה ובריטניה.
- מדיניות דמי ביטול (עד המקסימום שהחוק מתיר, או בלי דמי ביטול) – הגדרות ← ביטול עסקה.
- בדיקת הקטלוג: שמות היצירות (בעברית ובאנגלית), הסדרות, המידות (ובמיוחד יצירות שמסומנות "TODO"
  במידות זמניות), הצבעים בתמונות מול המקור, והמחירים: כולם מחושבים בנוסחה אחת (‎4,800 ₪ לציור
  אקריליק על קנבס בגודל 80×80, שמן +15%; ההסבר ב-docs/pricing/pricing-procedure.tex). המחירים
  אושרו, והיצירות מסומנות כאמיתיות (לא הדגמה): הן נמכרות בתשלום אמיתי ברגע שכל שאר הסעיפים ברשימת
  "מוכנות לעלייה לאוויר" נסגרים.

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
- **חשבון DHL** ומפתחות MyDHL API (בדיקות וייצור). עד אז מחירי המשלוח לחו״ל באתר הם מחירי
  המחירון ש-DHL מפרסמת; עם פתיחת החשבון – אחוז ההנחה על המחירון.
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
- **ביטול חלקי (יצירה אחת מתוך הזמנה)**: הזיכוי הוא על סכום ההחזר בלבד, עם השורה "ביטול עסקה
  C-XXXXXX: <שמות היצירות>". האם זה מספיק, או שצריך שורה לכל יצירה ושורה נפרדת לדמי הביטול?

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
  - נוסחי דחייה וסייג סעיף 2(ב2);
  - **ביטול לפי יצירה** (הקונה בוחר אילו יצירות מההזמנה לבטל): (1) דמי המשלוח והביטוח מוחזרים
    רק בביטול שלא משאיר אף יצירה פעילה – בביטול חלקי היצירות האחרות עדיין נשלחות; (2) דמי הביטול
    הם 5% מהסכום שמוחזר בפועל (היצירות, ובביטול האחרון גם המשלוח), ותקרת ‎100 ₪ אחת להזמנה כולה
    – הפרשנות המיטיבה עם הקונה; (3) האם אפשר לחייב את הקונה במשלוח מחדש אם החבילה כבר נארזה.
- **בלי כתובת דוא״ל גלויה**: האתר לא מציג דוא״ל בשום מקום; פונים דרך טופס יצירת הקשר ובטלפון,
  והודעות ביטול מתקבלות בטופס המקוון, בטלפון ובדואר רשום. האם זה עומד בדרישות (דרכי מסירת הודעת
  ביטול, פרטי העוסק בגילוי הנאות, פרטי קשר בהצהרת הנגישות ובמדיניות הפרטיות)?
- **קישור "ביטול עסקה"**: לבקשת האמנית הוא הוסר מהכותרת העליונה, ובתחתית כל עמוד הוא חלק מהפריט
  "ביטול עסקה והחזרות", שפותח את עמוד הביטול (ומשם קישור למדיניות המלאה). הקישור "ביטול עסקה" עצמו
  נשאר בקופה, בעמודי יצירת קשר, המסמכים המשפטיים וההזמנה, בכל מייל לקונה ובמסמכים. האם פריט בתחתית
  העמוד עומד בדרישה להציג בדף הבית, באופן בולט, קישור למסירת הודעת ביטול?
- **עגלת קניות**: עוגייה הכרחית אחת (`gg_cart`, מזהי היצירות בלבד, 30 יום) – נוסח שורת הפרטיות;
  יצירות בעגלה אינן שמורות לקונה עד "המשך לתשלום".
- **מחירים**: הצגת מחיר במטבע חוץ (סעיף 17ז(א)(1)); פרטי הסוחר לפי Visa; ניסוח "מבוטח".
- **חוצה גבולות ומידע**: GPSR ומכירה לאיחוד האירופי וטופס הביטול האירופי; משלוחים בערך נמוך
  לבריטניה; רשימת המדינות החסומות (עיראק? תימן?); הצגת מספר הזהות והכתובת העסקית; ספקי עיבוד
  והעברה לארה״ב; תקופות השמירה.
- **זכויות**: זכויות יוצרים וזכות מוסרית (תעודת מקוריות: סעיפים 37(ג) ו-45(ב) – לבדיקה); הסכמה
  לנתוני מעקב DHL.

## 5. סיור בהגדרות
- **הגדרות ← פרטי העסק ומע״מ**: שם, כתובות, טלפונים, מספר עוסק, מצב מע״מ. עד שמסמנים "הפרטים
  מלאים ומעודכנים", תשלומים אמיתיים חסומים.
- **הגדרות ← קופה ותשלומים**: זמני שמירה, מגבלות נגד "תפיסת" יצירות, שער הדולר, מספר תשלומים
  מקסימלי, האם להציע PayPal גם ליעדים בישראל, וקבלה לתשלומים שהוחזרו.
- **הגדרות ← משלוחים**: אזורים, הערכת DHL Express לחו״ל, דואר ישראל, תעריף בסיס לפי גודל (מחירון חברת
  השליחויות בארץ), תוספות (דלק, עונה), ביטוח ותקרת שווי מבוטח, תקרת שווי מוצהר לפי מוביל, מדינות,
  ספים (הצהרת יצוא), איסוף עצמי, שליח בארץ. אחרי העתקת מחירון השליחויות –
  "סימון: התעריפים כוילו היום".
- **היטל הדלק של DHL**: פעם בשבוע או שבועיים מעתיקים מעמוד התוספות של DHL (mydhl.express.dhl/il/en/ship/surcharges.html)
  את היטל הדלק הבין־לאומי לשבוע הקרוב ואת התאריך שלו (הגדרות ← משלוחים ← הערכת DHL Express).
  אחרי 14 יום בלי עדכון מופיע "לא עודכן". כש-DHL נותנת הנחה לחשבון, מזינים אותה שם; אם הצהרת
  היצוא מוגשת בנפרד ולא דרך DHL, מבטלים את הסימון.
- **דואר ישראל** (הגדרות ← משלוחים ← דואר ישראל): אפשר לכבות בנפרד את המשלוח עד הבית בארץ ואת
  EMS לחו״ל, ולבחור אם להוסיף ל-EMS את הביטוח של דואר ישראל. שם גם זמני המסירה שהקונה רואה.
  המחירים הם המחירונים שדואר ישראל פרסם, והם כתובים בקוד: כשיוצא מחירון חדש, מבקשים מהמפתח לעדכן.
- **מתוח או מגולגל**: בקופה הקונה בוחר/ת "מתוח על מסגרת, בקופסה" או "מגולגל בגליל". מגולגל זול בהרבה,
  וגם ציורים גדולים נכנסים לדואר ישראל. אפשר לכבות את האפשרות ליצירה מסוימת (למשל צבע עבה שעלול
  להיסדק): בעמוד היצירה בניהול מבטלים את הסימון "אפשר לגלגל את הבד לשליחה בגליל". משקל הגליל במחיר
  הוא הערכה (1.5 ק״ג ועוד 1.2 ק״ג למ״ר); כדאי לשקול גליל אחד ולספר למפתח.
- **הגדרות ← ביטול עסקה**: דמי הביטול המוצעים (הצעה בלבד – בכל ביטול אפשר רק להפחית).
- **חשבון**: סיסמה ואימות דו-שלבי (חובה באתר החי).
- בלוח הבקרה מופיעה רשימת "מוכנות לעלייה לאוויר": כל עוד יש בה פריט פתוח, תשלומים אמיתיים חסומים.

## 6. איך עושים…

### לטפל בהודעת ביטול
1. ההודעה מופיעה ב**ביטולים**, ממוינת לפי מועד ההחזר. מספר הזהות מוצג רק חלקית.
2. אם לא שויכה להזמנה – מזינים את מספר ההזמנה ולוחצים "שיוך להזמנה".
3. הודעה כפולה (אותו אדם שלח פעמיים, או גם התקשר) – "סגירה ככפילות" עם מספר ההודעה המקורית.
4. בודקים: חלון הביטול, מקור השיחה, דמי הביטול המוצעים. בהזמנה עם כמה יצירות מסומנות היצירות
   שהקונה בחר/ה לבטל; אפשר לשנות את הבחירה, והסכומים (החזר על היצירות, משלוח, דמי ביטול, החזר)
   מתעדכנים מיד.
5. **אישור הביטול**: אם היצירות לא נשלחו – ההחזר יוצא מיד. כשלא נשארת יצירה פעילה המשלוח מבוטל;
   בביטול חלקי החבילה חוזרת ל"ממתין לאריזה" ואורזים מחדש רק את היצירות שנשארו. אם נשלחו – נשלחות
   הוראות החזרה; כשהיצירות מגיעות מסמנים "היצירה התקבלה בסטודיו", מסמנים בבדיקה אילו נפגמו, ואז
   "ביצוע ההחזר".
6. אחרי שההחזר הושלם: "סגירת הטיפול", ואז "החזרה למכירה" – רק היצירות שבוטלו חוזרות למכירה (יצירה
   פגומה מסומנת כלא למכירה). ההזמנה עצמה מסומנת "בוטלה" רק כשכל היצירות שבה בוטלו.
7. הודעה שהתקבלה בטלפון, במייל או בדואר: **ביטולים ← רישום הודעת ביטול**, עם מועד הקבלה בפועל: 14 הימים להחזר נספרים ממנו.

### לענות להודעה (כל עוד האתר במצב תצוגה)
כל עוד אין באתר רכישה מקוונת, המבקרים לא מקבלים מיילים מהאתר, וכל הודעה חדשה מגיעה במייל לכתובת
ההתראות.
1. במייל ובמסך ההודעה (**תיבת ההודעות**) מופיעים הטלפון של השולח/ת, עם קישור לשיחה ולוואטסאפ, והדוא״ל.
2. עונים בטלפון או בוואטסאפ.
3. במסך ההודעה לוחצים "סימון כנענתה". אפשר להוסיף הערה פנימית (למשל "תיאמנו ביקור ביום ראשון"); היא
   לא נשלחת לאף אחד.
4. יצירה שנמכרה כך: בעמוד היצירה בממשק הניהול, "מכירה מחוץ לאתר". היצירה תוצג באתר כנמכרה.

### לאשר החזר "לא ידוע" או "נכשל"
נכנסים ללוח הבקרה של Cardcom או PayPal ומוצאים את העסקה לפי מספר ההזמנה. במסך ההזמנה:
- החזר **לא ידוע**: "בדיקה מול הספק"; אם עדיין לא ברור – "בדקתי בלוח הבקרה: ההחזר בוצע" או
  "…ההחזר לא בוצע".
- החזר **שנכשל**: "בדקתי בלוח הבקרה של הספק: לא הוחזר כסף", ואז "ניסיון חוזר". עד האישור הזה
  ההחזר שנכשל נספר בתקרת ההחזרים, כדי שלא יוחזר כסף פעמיים.

### לשלוח הזמנה מגולגלת
1. בהזמנה כתוב "מגולגל בגליל (בחירת הקונה)", ובמסך "הכנה למשלוח" סוג האריזה של היצירה הוא "גליל".
2. מורידים את הבד ממסגרת המתיחה, מגלגלים כשהצבע כלפי חוץ, עם נייר מגן בין השכבות, ושמים בגליל
   בקוטר 25 ס״מ לפחות (רשימת האריזה כוללת את השלבים).
3. מידות החבילה המוצעות הן של הגליל; אם הגליל שונה, מתקנים לפני "ארוז".
4. שולחים בשיטה שהקונה בחר/ה (דואר ישראל או שליח/DHL), כרגיל.

### לשלוח הזמנה בדואר ישראל
1. בהזמנה כתוב "דואר ישראל – עד הבית" (בארץ) או "דואר ישראל – EMS" (לחו״ל). האתר מציע את דואר
   ישראל רק כשהחבילה עומדת במגבלות שלו: עד 20 ק״ג, בלי ארגז עץ ובלי זכוכית, ובגודל שהיעד מקבל.
2. אורזים כרגיל, בקרטון.
3. מביאים את החבילה לסניף: בארץ – "מאשנב לדלת מהיום למחר"; לחו״ל – EMS. לחו״ל ממלאים בסניף את
   הצהרת המכס לפי החשבונית המסחרית (ממסך "הכנה למשלוח"). כשההזמנה מבוטחת, מבקשים הרחבת אחריות על
   הסכום המבוטח שבהזמנה.
4. לחו״ל, הכנת המשלוח מראש באתר דואר ישראל ("הכן מהבית") זולה ב-5 ₪ ממחיר הסניף שהקונה שילם.
5. במסך "הכנה למשלוח", ב"מעקב ידני (חברת שילוח אחרת)": חברת השילוח "דואר ישראל", מספר המעקב,
   וסימון שהחבילה נמסרה.
6. האתר מחשב את EMS לפי המשקל בפועל, כמו במחירון. אם בסניף גובים יותר על חבילה גדולה, מספרים
   למפתח.

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
  pickup.
- Which works can be rolled into a tube; framing and glazing.
- Shipping insurance (DHL or a third party) and written confirmation of the coverage.
- Shipping rate calibration; opening Europe and the UK.
- The cancellation fee policy (up to the legal maximum, or no fee): Settings → Cancellations.
- Review the catalog: the titles (Hebrew and English), the series, the sizes (especially works
  marked "TODO" with a placeholder size), the colours of the photos against the originals, and
  the prices. Every price comes from one formula (NIS 4,800 for an 80×80 acrylic on canvas, oil
  +15 %; explained in `docs/pricing/pricing-procedure.tex`). The prices are confirmed and the
  works are real listings (not demo): they sell for real money as soon as every other item on the
  "go-live readiness" list is closed.

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
- **A DHL account** and MyDHL API keys (test and production). Until then the site prices shipments
  abroad at DHL's published list prices; once the account exists, ask for its discount on them.
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
- **Partial cancellation (one work of an order):** the credit note is for the refunded amount
  only, with the line "Cancellation C-XXXXXX: <titles of the works>". Is that enough, or does it
  need one line per work and a separate line for the cancellation fee?

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
  - rejection templates and the s.2(b2) exception;
  - **cancellation per work** (the buyer chooses which works of an order to cancel):
    1. Shipping and insurance are refunded only by the cancellation that leaves no active work. On
       a partial cancellation the other works still ship.
    2. The fee is 5% of what is actually refunded: the works, plus the shipping on the last
       cancellation. There is one ₪100 cap for the whole order, which is the reading most
       favourable to the buyer.
    3. Whether the buyer may be charged for repacking when the parcel was already packed.
- **No public email:** the site shows no email address anywhere. Visitors write through the
  contact form or phone, and cancellation notices come through the online form, by phone or by
  registered mail. Does that meet the requirements: the ways to give a cancellation notice, the
  seller's details in the disclosure, and the contact details in the accessibility statement and
  the privacy policy?
- **The "Cancel a purchase" link:** at the painter's request it was removed from the header, and in
  the footer of every page it is part of the "Cancellations and returns" item, which opens the
  cancellation page (with a link to the full policy). The "Cancel a purchase" link itself stays in
  the checkout, on the contact, legal and order pages, in every buyer email and in documents. Does
  a footer item meet the requirement to show, prominently on the home page, a link for sending a
  cancellation notice?
- **Shopping cart:**
  - The privacy text for its one strictly necessary cookie (`gg_cart`: artwork ids only, 30
    days).
  - Works in the cart are not reserved for the buyer until "Continue to payment".
- **Pricing:** showing prices in a foreign currency (s.17G(a)(1)); Visa's merchant-disclosure
  details; the wording of "insured".
- **Cross-border and data:** GPSR, selling to the EU, and the EU model withdrawal form; UK
  low-value consignments; the list of blocked countries (Iraq? Yemen?); showing the ID number
  and the business address; processors and transfers to the US; retention periods.
- **Rights:** copyright and moral rights (certificate of authenticity: s.37(c) and s.45(b), to be
  checked); consent for DHL tracking data.

## 5. Settings walkthrough
- **Settings → Business details and VAT:** name, addresses, phones, business number, VAT mode.
  Real payments stay blocked until you tick "The details are complete and current".
- **Settings → Checkout and payments:** hold times, anti-hoarding limits, the USD rate, the
  maximum number of installments, whether PayPal is offered for Israeli destinations too, and
  receipts for refunded payments.
- **Settings → Shipping:** zones, the DHL Express estimate abroad, Israel Post, base rate by size (your Israeli
  courier's price list), surcharges (fuel, season), insurance and the insured-value cap, the
  declared-value cap per carrier, countries, thresholds (export declaration), studio pickup, the
  domestic courier. After copying the courier's prices, press "Mark
  the rates as calibrated today".
- **DHL's fuel surcharge:** every week or two, copy DHL's international fuel surcharge for the
  coming week and its date from DHL's surcharges page
  (mydhl.express.dhl/il/en/ship/surcharges.html) into Settings → Shipping → DHL Express estimate.
  After 14 days without an update the page shows "not updated". When DHL gives your account a
  discount, enter it there; if the export declaration is filed separately rather than through DHL,
  untick that box.
- **Israel Post** (Settings → Shipping → Israel Post): home delivery in Israel and EMS abroad can
  each be switched off, and you choose whether EMS includes Israel Post's insurance. The delivery
  times buyers see are there too. The prices are Israel Post's published price lists, written in
  the code: when a new price list comes out, ask the developer to update them.
- **Stretched or rolled:** at checkout the buyer chooses "Stretched, in a box" or "Rolled in a
  tube". Rolled costs far less, and large paintings then fit Israel Post. To turn it off for one
  work (thick paint that could crack, for example), untick "The canvas can be rolled for a tube" on
  the work's admin page. The tube's weight in the price is an estimate (1.5 kg plus 1.2 kg per m²);
  weigh one rolled parcel and tell the developer.
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
4. Check the cancellation window, the conversation source and the suggested fee. For an order
   with several works, the works the buyer chose are ticked. You can change the choice, and the
   amounts update at once: works refunded, shipping, fee and refund.
5. **Accept cancellation.**
   - If the works were not shipped, the refund goes out at once. When no work is left, the
     shipment is cancelled. On a partial cancellation the parcel goes back to "Awaiting
     fulfillment", and only the remaining works are packed again.
   - If they were shipped, return instructions are sent. When the works arrive, press "The work
     arrived at the studio", tick the damaged ones during inspection, then "Make the refund".
6. Once the refund is complete, press "Close", then "Relist for sale". Only the cancelled works go
   back on sale, and a damaged work is marked not for sale. The order itself shows "Cancelled"
   only when every work in it was cancelled.
7. A notice received by phone, email or post: **Cancellations → Log a notice**, with the actual
   time it was received; the 14 days for the refund count from it.

### Answer a message (while the site is a showcase)
While online purchase is closed, visitors get no emails from the site, and every new message
arrives by email at the notification address.
1. The email and the message screen (**Inbox**) show the sender's phone, with call and WhatsApp
   links, and their email.
2. Answer by phone or WhatsApp.
3. On the message screen, press "Mark as answered". You can add an internal note (for example
   "Studio visit on Sunday"); it is sent to no one.
4. A work sold this way: on the work's admin page, "Sold outside the site". The site then shows it
   as sold.

### Confirm an "unknown" or "failed" refund
Open the Cardcom or PayPal dashboard and find the transaction by order number. Then, on the
order page:
- An **unknown** refund: press "Check with the provider". If it is still unclear, press "I checked
  the dashboard: the refund went through" or "…no refund was made".
- A **failed** refund: press "I checked the provider dashboard: no money was refunded", then
  "Retry". Until you confirm, the failed refund counts against the refund cap, so money is never
  refunded twice.

### Ship a rolled order
1. The order says "rolled in a tube (the buyer's choice)", and on the fulfillment screen the work's
   packaging is "tube".
2. Take the canvas off its stretcher, roll it paint side out with protective paper between the
   layers, and put it in a tube at least 25 cm (10 in) across; the packing checklist lists the
   steps.
3. The suggested parcel size is the tube's; correct it before "Packed" if your tube differs.
4. Ship by the method the buyer chose (Israel Post, or the courier/DHL), as usual.

### Ship an Israel Post order
1. The order says "Israel Post – home delivery" (in Israel) or "Israel Post EMS" (abroad). The site
   offers Israel Post only when the parcel fits its limits: up to 20 kg, no wooden crate, no glass,
   and a size the destination accepts.
2. Pack as usual, in a cardboard box.
3. Take the parcel to a post office: in Israel, counter-to-door next-day delivery; abroad, EMS.
   Abroad, fill in the customs declaration at the counter from the commercial invoice (on the
   fulfillment screen). When the order is insured, ask for the liability extension on the order's
   insured value.
4. Abroad, preparing the parcel online on Israel Post's site ("prepare at home") costs ₪5 less than
   the counter price the buyer paid.
5. On the fulfillment screen, under "Manual tracking (another carrier)": carrier "Israel Post", the
   tracking number, and tick that the parcel was handed over.
6. The site prices EMS by actual weight, as the price list does. If the counter charges more for a
   large parcel, tell the developer.

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
