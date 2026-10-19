import { APP_PACKAGE } from "./constants.js";

/**
 * Catalog of known failures, with Hebrew explanations and fixes. Used by both installers to
 * explain an error in place, and by the site's /help page, so the two never drift apart.
 */
export interface KnownError {
  id: string;
  /** Short Hebrew title. */
  title: string;
  /** The message as the user sees it (English text from Android or adb, or a Hebrew symptom). */
  message: string;
  match: RegExp[];
  explanation: string;
  fix: string[];
  /** Optional shell commands to show with copy buttons. */
  commands?: string[];
}

export const KNOWN_ERRORS: KnownError[] = [
  {
    id: "update-incompatible",
    title: "גרסה אחרת של האפליקציה כבר מותקנת",
    message: "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
    match: [/INSTALL_FAILED_UPDATE_INCOMPATIBLE/i, /signatures do not match/i],
    explanation:
      "במכשיר מותקנת כבר שני שבילין שנחתמה בחתימה אחרת (למשל גרסת ניסיון או גרסה ממקור אחר). " +
      "אנדרואיד לא מאפשר לעדכן אפליקציה בחתימה שונה.",
    fix: [
      "אם הסינון פעיל במכשיר: פותחים את האפליקציה, הגדרות > \"הסרת הפילטר\", מקלידים את הסיסמה ומאשרים.",
      "אחרי ההסרה (או אם הסינון לא הופעל), מסירים את האפליקציה מהמכשיר, או מריצים את הפקודה שלמטה מהמחשב.",
      "מתחילים את ההתקנה מחדש.",
    ],
    commands: [`adb uninstall ${APP_PACKAGE}`],
  },
  {
    id: "version-downgrade",
    title: "במכשיר מותקנת גרסה חדשה יותר",
    message: "INSTALL_FAILED_VERSION_DOWNGRADE",
    match: [/INSTALL_FAILED_VERSION_DOWNGRADE/i, /Downgrade detected/i],
    explanation: "הגרסה שמותקנת במכשיר חדשה יותר מהגרסה שמנסים להתקין, ואנדרואיד לא מאפשר לחזור לגרסה ישנה.",
    fix: [
      "בדרך כלל אין צורך לעשות דבר: הגרסה שבמכשיר עדכנית.",
      "אם בחרתם במסלול הבטא ועברתם לגרסה היציבה, המתינו לגרסה יציבה חדשה יותר, או התקינו שוב את הבטא.",
    ],
  },
  {
    id: "accounts",
    title: "יש חשבונות במכשיר",
    message: "Not allowed to set the device owner because there are already some accounts on the device",
    match: [/already some accounts/i, /accounts on the device/i],
    explanation:
      "אנדרואיד מאפשר להגדיר מנהל מכשיר רק כשאין במכשיר אף חשבון. " +
      "גם אפליקציות כמו WhatsApp, Telegram או אפליקציות של היצרן (Samsung, Xiaomi) יוצרות חשבון.",
    fix: [
      "במכשיר: הגדרות > חשבונות (או \"חשבונות וגיבוי\" > \"ניהול חשבונות\").",
      "נכנסים לכל חשבון ולוחצים \"הסרת חשבון\". חוזרים על זה עד שהרשימה ריקה.",
      "אם חשבון לא נמחק (למשל של WhatsApp), מסירים זמנית את האפליקציה שיצרה אותו. אפשר להתקין אותה שוב אחרי ההגדרה.",
      "לוחצים \"בדיקה מחדש\". אחרי סיום ההגדרה אפשר להוסיף חשבונות מחדש.",
    ],
  },
  {
    id: "users",
    title: "יש במכשיר משתמשים או פרופילים נוספים",
    message: "Not allowed to set the device owner because there are already several users on the device",
    match: [/several users/i, /already several users/i],
    explanation:
      "אנדרואיד מאפשר להגדיר מנהל מכשיר רק כשיש משתמש אחד בלבד. " +
      "משתמש נוסף יכול להיות אורח, פרופיל עבודה, \"תיקייה מאובטחת\" של סמסונג, \"מרחב שני\" או \"אפליקציות כפולות\" של שיאומי.",
    fix: [
      "הגדרות > מערכת > \"משתמשים מרובים\" (או \"משתמשים\"): מוחקים כל משתמש מלבד הבעלים, כולל אורח.",
      "סמסונג: מוחקים את \"התיקייה המאובטחת\" (הגדרות > אבטחה ופרטיות) ומכבים את Dual Messenger.",
      "שיאומי: מוחקים את \"מרחב שני\" ומכבים \"אפליקציות כפולות\" (Dual apps).",
      "פרופיל עבודה: הגדרות > חשבונות > \"עבודה\" > \"הסרת פרופיל העבודה\".",
      "ההתקנה אף פעם לא מוחקת משתמשים לבד. אחרי המחיקה לוחצים \"בדיקה מחדש\".",
    ],
  },
  {
    id: "already-owner",
    title: "כבר מוגדר מנהל מכשיר אחר",
    message: "Trying to set the device owner, but device owner is already set",
    match: [/device owner is already set/i, /already has a device owner/i, /already a device owner/i, /already set as the device owner/i],
    explanation:
      "אפליקציה אחרת (למשל סינון אחר או ניהול של חברה) כבר מוגדרת כמנהלת המכשיר. במכשיר יכול להיות מנהל אחד בלבד.",
    fix: [
      "אם זה סינון אחר: מסירים אותו לפי ההוראות שלו (בדרך כלל דרך האפליקציה שלו, עם סיסמה).",
      "אם אין דרך להסיר אותו: מגבים את המידע ומבצעים איפוס יצרן.",
      "אם מנהל המכשיר הוא שני שבילין עצמה, ההתקנה תציע עדכון בלבד.",
    ],
  },
  {
    id: "already-provisioned",
    title: "המכשיר כבר הוגדר",
    message: "Not allowed to set the device owner because the device has already been provisioned",
    match: [/already been provisioned/i, /already provisioned/i],
    explanation: "בחלק מהמכשירים אפשר להגדיר מנהל מכשיר רק לפני סיום ההגדרה הראשונית, או מיד אחרי איפוס יצרן.",
    fix: [
      "מגבים את המידע ומבצעים איפוס יצרן.",
      "בהגדרה הראשונית מדלגים על הוספת חשבון Google.",
      "מפעילים ניפוי באגים ב-USB ומריצים את ההתקנה שוב.",
    ],
  },
  {
    id: "unknown-admin",
    title: "רכיב הניהול עדיין לא נרשם",
    message: "Unknown admin: ComponentInfo{com.abaye.shanishvilin/...AdminReceiver}",
    match: [/Unknown admin/i],
    explanation: "האפליקציה הותקנה, אבל המערכת עוד לא סיימה לרשום את רכיב הניהול שלה, או שההתקנה לא הושלמה.",
    fix: ["ממתינים כמה שניות ולוחצים \"ניסיון חוזר\".", "אם זה חוזר, מסירים את האפליקציה ומתקינים מחדש."],
  },
  {
    id: "xiaomi-security",
    title: "חסרה הרשאת \"ניפוי באגים (הגדרות אבטחה)\"",
    message: "SecurityException: ... MANAGE_DEVICE_ADMINS / INTERACT_ACROSS_USERS",
    match: [/MANAGE_DEVICE_ADMINS/i, /INTERACT_ACROSS_USERS/i, /MANAGE_PROFILE_AND_DEVICE_OWNERS/i],
    explanation: "במכשירי שיאומי (MIUI / HyperOS) פקודות ניהול חסומות עד שמפעילים את \"ניפוי באגים ב-USB (הגדרות אבטחה)\".",
    fix: [
      "אפשרויות מפתחים > מפעילים \"ניפוי באגים ב-USB (הגדרות אבטחה)\". נדרש חשבון Mi מחובר.",
      "אם נכנסתם לחשבון Mi רק לשם כך: מפעילים, יוצאים מחשבון ה-Mi, ורק אז ממשיכים בהתקנה.",
    ],
  },
  {
    id: "user-restricted",
    title: "המכשיר חוסם התקנה דרך USB",
    message: "INSTALL_FAILED_USER_RESTRICTED",
    match: [/INSTALL_FAILED_USER_RESTRICTED/i],
    explanation: "בשיאומי ובחלק ממכשירי Oppo ו-Vivo יש מתג נפרד שמאפשר התקנה דרך USB.",
    fix: [
      "אפשרויות מפתחים > מפעילים \"התקנה דרך USB\" (Install via USB). בשיאומי נדרש חשבון Mi מחובר.",
      "אם מופיעה במכשיר שאלה לאשר את ההתקנה, מאשרים בזמן.",
    ],
  },
  {
    id: "install-aborted",
    title: "ההתקנה לא אושרה במכשיר",
    message: "INSTALL_FAILED_ABORTED",
    match: [/INSTALL_FAILED_ABORTED/i, /User rejected permissions/i],
    explanation: "המכשיר הציג שאלה אם לאשר את ההתקנה, והיא נדחתה או שהזמן עבר.",
    fix: ["מריצים שוב את שלב ההתקנה ומאשרים במכשיר."],
  },
  {
    id: "insufficient-storage",
    title: "אין מספיק מקום פנוי",
    message: "INSTALL_FAILED_INSUFFICIENT_STORAGE",
    match: [/INSTALL_FAILED_INSUFFICIENT_STORAGE/i, /No space left on device/i],
    explanation: "אין במכשיר מספיק מקום פנוי להתקנה.",
    fix: ["מוחקים קבצים או אפליקציות שאינם בשימוש (לפחות 300 MB פנויים) ומנסים שוב."],
  },
  {
    id: "no-matching-abis",
    title: "הקובץ לא מתאים למעבד של המכשיר",
    message: "INSTALL_FAILED_NO_MATCHING_ABIS",
    match: [/INSTALL_FAILED_NO_MATCHING_ABIS/i],
    explanation: "הקובץ שנבחר בנוי לסוג מעבד אחר.",
    fix: ["בוחרים בקובץ של armeabi-v7a, שמתאים לכל המכשירים עם מעבד ARM, או בקובץ האוניברסלי מעמוד ההורדות."],
  },
  {
    id: "older-sdk",
    title: "גרסת האנדרואיד ישנה מדי",
    message: "INSTALL_FAILED_OLDER_SDK",
    match: [/INSTALL_FAILED_OLDER_SDK/i],
    explanation: "שני שבילין דורשת אנדרואיד 7 ומעלה.",
    fix: ["אם יש למכשיר עדכון מערכת, מעדכנים ומנסים שוב."],
  },
  {
    id: "unauthorized",
    title: "המכשיר לא אישר את המחשב",
    message: "unauthorized",
    match: [/\bunauthorized\b/i, /device unauthorized/i],
    explanation: "המכשיר מחובר, אבל עוד לא אישר ניפוי באגים מהמחשב הזה.",
    fix: [
      "פותחים את מסך המכשיר ומחפשים את החלון \"לאפשר ניפוי באגים ב-USB?\". מסמנים \"אפשר תמיד מהמחשב הזה\" ולוחצים \"אישור\".",
      "אם החלון לא מופיע: אפשרויות מפתחים > \"ביטול הרשאות לניפוי באגים ב-USB\", מנתקים ומחברים את הכבל שוב.",
    ],
  },
  {
    id: "no-devices",
    title: "המכשיר לא מזוהה",
    message: "no devices/emulators found",
    match: [/no devices/i, /device not found/i, /No device selected/i, /NotFoundError/i],
    explanation: "המחשב לא רואה את המכשיר כמכשיר לניפוי באגים.",
    fix: [
      "מוודאים שניפוי באגים ב-USB מופעל באפשרויות המפתחים.",
      "מחליפים כבל: חלק מהכבלים מיועדים לטעינה בלבד ולא מעבירים נתונים. עדיף לחבר ישירות למחשב ולא דרך מפצל.",
      "בהתראת ה-USB במכשיר בוחרים \"העברת קבצים\".",
      "בחלונות, חלק מהמכשירים (בעיקר סמסונג) צריכים את מנהל ההתקן (driver) של היצרן.",
    ],
  },
  {
    id: "usb-busy",
    title: "חיבור ה-USB תפוס על ידי תוכנה אחרת",
    message: "Unable to claim interface / The device is already in use",
    match: [/claim interface/i, /already in use/i, /DeviceBusy/i, /Access denied/i],
    explanation:
      "תוכנה אחרת במחשב מחזיקה את חיבור ה-USB של המכשיר, בדרך כלל adb.exe שרץ ברקע " +
      "(למשל מתוכנת ההתקנה למחשב, Android Studio או scrcpy).",
    fix: [
      "סוגרים את תוכנת ההתקנה למחשב ותוכנות כמו Android Studio או scrcpy.",
      "אם adb מותקן במחשב, מריצים את הפקודה שלמטה, או סוגרים את adb.exe במנהל המשימות.",
      "סוגרים לשוניות אחרות שמחוברות למכשיר, מנתקים ומחברים את הכבל ומנסים שוב.",
    ],
    commands: ["adb kill-server"],
  },
  {
    id: "filter-blocked",
    title: "ההורדה נחסמה בסינון",
    message: "הקובץ שהתקבל אינו קובץ התקנה",
    match: [/filter-blocked/],
    explanation:
      "במקום קובץ ההתקנה התקבל דף אינטרנט או קובץ קטן מדי. בדרך כלל זה אומר שהסינון של ספק האינטרנט חסם את ההורדה.",
    fix: [
      "מבקשים מספק הסינון לפתוח את הכתובת shanishvilin.abaye.co.",
      "או מורידים את הקובץ ממקום אחר (או ממחשב אחר) ובוחרים \"בחירת קובץ מהמחשב\".",
    ],
  },
  {
    id: "qr-camera",
    title: "קוד ה-QR נסרק במצלמה",
    message: "הסריקה פתחה דפדפן או טקסט, ולא התחילה התקנה",
    match: [/qr-camera/],
    explanation: "את קוד ה-QR סורקים רק מתוך אשף ההגדרה של מכשיר מאופס, ולא במצלמה הרגילה.",
    fix: [
      "מבצעים איפוס יצרן (או מתחילים ממכשיר חדש).",
      "במסך הפתיחה הראשון (\"שלום\" / \"ברוכים הבאים\") מקישים 6 פעמים באותו מקום.",
      "נפתח קורא QR של אשף ההגדרה. סורקים בו את הקוד.",
    ],
  },
];

export function findKnownError(text: string | null | undefined): KnownError | null {
  if (!text) return null;
  for (const e of KNOWN_ERRORS) {
    if (e.match.some((r) => r.test(text))) return e;
  }
  return null;
}

export function knownError(id: string): KnownError {
  const e = KNOWN_ERRORS.find((x) => x.id === id);
  if (!e) throw new Error(`Unknown error id: ${id}`);
  return e;
}

/** Installer-internal failures. Not listed on /help, but explained the same way. */
const INTERNAL_ERRORS: Record<string, Omit<KnownError, "id" | "match" | "message">> = {
  "download-failed": {
    title: "ההורדה נכשלה",
    explanation: "לא הצלחנו להוריד את קובץ ההתקנה מהאתר. ייתכן שאין חיבור לאינטרנט או שהסינון חוסם את האתר.",
    fix: ["בודקים את החיבור לאינטרנט ולוחצים \"בדיקה מחדש\".", "או בוחרים קובץ התקנה שהורד מראש (\"בחירת קובץ מהמחשב\")."],
  },
  "sha-mismatch": {
    title: "הקובץ שהורד פגום",
    explanation: "טביעת האצבע (SHA-256) של הקובץ שהורד לא תואמת לגרסה שפורסמה. ייתכן שההורדה נקטעה או שהקובץ שונה בדרך.",
    fix: ["לוחצים \"בדיקה מחדש\" כדי להוריד שוב.", "אם זה חוזר, ייתכן שהסינון משנה את הקובץ. מורידים ממקום אחר ובוחרים קובץ מהמחשב."],
  },
  "wrong-package": {
    title: "זה לא קובץ ההתקנה של שני שבילין",
    explanation: "הקובץ שנבחר הוא אפליקציה אחרת.",
    fix: ["מורידים את הקובץ מעמוד ההורדות באתר ובוחרים אותו שוב."],
  },
  "wrong-cert": {
    title: "הקובץ חתום בחתימה לא מוכרת",
    explanation: "הקובץ אינו גרסה רשמית של שני שבילין: החתימה שלו שונה מחתימת הגרסאות שפורסמו. מטעמי בטיחות לא נתקין אותו.",
    fix: ["מורידים את הקובץ מעמוד ההורדות באתר בלבד."],
  },
  "not-apk": {
    title: "הקובץ אינו קובץ התקנה",
    explanation: "הקובץ שנבחר אינו קובץ APK תקין.",
    fix: ["בוחרים קובץ שמסתיים ב-.apk מעמוד ההורדות."],
  },
  "install-failed": {
    title: "ההתקנה נכשלה",
    explanation: "המכשיר דחה את ההתקנה. הפרטים המלאים מופיעים ביומן.",
    fix: ["לוחצים \"ניסיון חוזר\".", "אם זה חוזר, מעתיקים את היומן ושולחים אלינו: shanishvilin@abaye.co"],
  },
  "owner-failed": {
    title: "הגדרת מנהל המכשיר נכשלה",
    explanation: "המכשיר סירב להגדיר את שני שבילין כמנהלת המכשיר. הפרטים המלאים מופיעים ביומן.",
    fix: ["בודקים שאין חשבונות ומשתמשים נוספים ולוחצים \"ניסיון חוזר\".", "אם זה חוזר, מעתיקים את היומן ושולחים אלינו: shanishvilin@abaye.co"],
  },
  "tools-download": {
    title: "לא הצלחנו להוריד את כלי החיבור",
    explanation:
      "בפעם הראשונה התוכנה מורידה מגוגל (dl.google.com) את כלי החיבור הרשמי, platform-tools. ההורדה נכשלה, אולי בגלל הסינון או שאין חיבור לאינטרנט.",
    fix: [
      "בודקים את החיבור לאינטרנט ולוחצים שוב \"חיבור למכשיר\".",
      "אם ההורדה חסומה: מבקשים מספק הסינון לאשר את dl.google.com,",
      "או מורידים את platform-tools ממחשב אחר, ומעתיקים את adb.exe, AdbWinApi.dll ו-AdbWinUsbApi.dll לתיקייה שבה נמצאת תוכנת ההתקנה.",
    ],
  },
  "adb-missing": {
    title: "כלי החיבור חסר",
    explanation: "הקובץ adb.exe לא נמצא. ייתכן שהוא נמחק או נחסם על ידי תוכנת אבטחה.",
    fix: ["סוגרים ופותחים את התוכנה מחדש. היא תוריד את כלי החיבור שוב."],
  },
  disconnected: {
    title: "החיבור למכשיר נותק",
    explanation: "הכבל נותק או שהמכשיר יצא ממצב ניפוי באגים.",
    fix: ["מחברים שוב את הכבל וחוזרים לשלב החיבור."],
  },
};

export interface ErrorDescription {
  id: string;
  title: string;
  explanation: string;
  fix: string[];
  commands?: string[];
  detail?: string;
}

/** Turns anything thrown into a Hebrew explanation. */
export function describeError(err: unknown): ErrorDescription {
  const msg = err instanceof Error ? err.message : String(err);
  const id = err instanceof InstallerError ? err.id : findKnownError(msg)?.id ?? "unknown";
  // An InstallerError without its own message carries only the id; nothing technical to show.
  const raw = msg && msg !== id ? msg : undefined;
  const known = KNOWN_ERRORS.find((e) => e.id === id);
  if (known) return { id, title: known.title, explanation: known.explanation, fix: known.fix, commands: known.commands, detail: raw };
  const internal = INTERNAL_ERRORS[id];
  if (internal) return { id, ...internal, detail: raw };
  return {
    id: "unknown",
    title: "אירעה שגיאה",
    explanation: "משהו השתבש. הפרטים מופיעים ביומן.",
    fix: ["מנסים שוב.", "אם זה חוזר, מעתיקים את היומן ושולחים אלינו: shanishvilin@abaye.co"],
    detail: raw ?? msg,
  };
}

/** An error carrying a catalog id, thrown by the core and the backends. */
export class InstallerError extends Error {
  constructor(
    readonly id: string,
    message?: string,
    readonly detail?: string,
  ) {
    super(message ?? id);
    this.name = "InstallerError";
  }
}
