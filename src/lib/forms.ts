/**
 * Field names shared by public forms and `publicAction` (spec §7 Abuse). Isomorphic constants.
 */
/** Honeypot: hidden from people; bots that fill it are rejected. */
export const HONEYPOT_FIELD = "company_website";
/** Signed timestamp of when the form was rendered (minimum form age). */
export const FORM_START_FIELD = "form_started_at";
/** Every Server Action input carries the locale (spec §2.2). */
export const LOCALE_FIELD = "locale";
