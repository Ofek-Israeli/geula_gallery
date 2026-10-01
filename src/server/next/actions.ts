import "server-only";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { en as zodEn, he as zodHe } from "zod/locales";
import { FORM_START_FIELD, HONEYPOT_FIELD, LOCALE_FIELD } from "@/lib/forms";
import { isLocale, LOCALE_VALUES, type Locale } from "@/lib/locale";
import { customIssueMessage } from "@/lib/validation/messages";
import type { AdminContext } from "@/server/domain/admin";
import type { ServiceResult } from "@/server/domain/effects";
import { env } from "@/server/env";
import { log } from "@/server/log";
import { ipHashFrom } from "@/server/security/ip";
import type { LimitName } from "@/server/security/limits";
import { checkLimit } from "@/server/security/rate-limit";
import { formAgeMs } from "@/server/security/tokens";
import { applyEffects } from "./effects";
import { requireAdmin } from "./guards";

/**
 * Server Action wrappers (spec §2.2, §9.3): zod-parse → guard → service → applyEffects.
 *
 * Signature of the returned action: `(prev, payload) => Promise<ActionState<T>>`, which is what
 * `useActionState` expects. Call it directly as `action(null, { locale, … })`.
 * Every input carries `locale` (validated here and passed to the handler).
 */

export type ActionErrorCode =
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "TOO_FAST"
  | "SPAM"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "UNEXPECTED"
  | (string & {});

export interface ActionError {
  code: ActionErrorCode;
  /** Optional localized message chosen by the handler. */
  message?: string;
  formErrors?: string[];
  fieldErrors?: Record<string, string[] | undefined>;
  retryAfterSec?: number;
}

export type ActionState<T> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError }
  | null;

/** Throw from a handler to return a typed failure (no stack logged). */
export class ActionFailure extends Error {
  constructor(
    public readonly code: ActionErrorCode,
    public readonly details: Omit<ActionError, "code"> = {},
  ) {
    super(code);
    this.name = "ActionFailure";
  }
}

type Payload = FormData | Record<string, unknown>;

/** FormData → plain object; repeated keys become arrays. */
export function formDataToObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

function toObject(payload: Payload | undefined): Record<string, unknown> {
  if (!payload) return {};
  return payload instanceof FormData
    ? formDataToObject(payload)
    : { ...payload };
}

const localeSchema = z.enum(LOCALE_VALUES);

function zodErrorMap(locale: Locale): z.core.$ZodErrorMap {
  const base = (locale === "he" ? zodHe() : zodEn()).localeError;
  // Custom issues from src/lib/validation carry a code with bilingual text.
  return (issue) => customIssueMessage(issue, locale) ?? base(issue);
}

function parseLocale(raw: Record<string, unknown>): Locale | null {
  const parsed = localeSchema.safeParse(raw[LOCALE_FIELD]);
  return parsed.success ? parsed.data : null;
}

function invalid(error: z.ZodError): { ok: false; error: ActionError } {
  const flat = z.flattenError(error);
  return {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      formErrors: flat.formErrors,
      fieldErrors: flat.fieldErrors as Record<string, string[] | undefined>,
    },
  };
}

function handleFailure(
  error: unknown,
  action: string,
): { ok: false; error: ActionError } {
  unstable_rethrow(error); // redirect() / notFound() must propagate (spec §2.2)
  if (error instanceof ActionFailure) {
    return { ok: false, error: { code: error.code, ...error.details } };
  }
  log.error("action.unexpected_error", { action }, error);
  return { ok: false, error: { code: "UNEXPECTED" } };
}

export interface AdminActionOptions {
  /** Money and settings actions: the session must be ≤ 30 min old (spec §7). */
  fresh?: boolean;
  /** Name used in logs. */
  name?: string;
}

/**
 * Wraps every export of an admin `actions.ts` (spec §6.10; enforced by the architecture test).
 * Runs `requireAdmin` (redirects when signed out / not enrolled / stale) before parsing.
 */
export function adminAction<S extends z.ZodType, T>(
  schema: S,
  handler: (input: z.output<S>, ctx: AdminContext) => Promise<ServiceResult<T>>,
  opts: AdminActionOptions = {},
): (prev: ActionState<T>, payload: Payload) => Promise<ActionState<T>> {
  return async (_prev, payload) => {
    const raw = toObject(payload);
    const locale = parseLocale(raw);
    const ctx = await requireAdmin({
      fresh: opts.fresh,
      locale: locale ?? undefined,
    });
    if (!locale) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", formErrors: ["locale"] },
      };
    }
    const parsed = schema.safeParse(raw, { error: zodErrorMap(locale) });
    if (!parsed.success) return invalid(parsed.error);
    try {
      const { result, effects } = await handler(parsed.data, ctx);
      applyEffects(effects);
      return { ok: true, data: result };
    } catch (error) {
      return handleFailure(error, opts.name ?? "admin");
    }
  };
}

export interface PublicActionMeta {
  locale: Locale;
  /** HMAC of the client IP; null when unknown. */
  ipHash: string | null;
}

export type PublicLimit<I> =
  | { name: LimitName; by: "ip" }
  | { name: LimitName; by: (input: I) => string | null | undefined };

export interface PublicActionOptions<I> {
  /** Reject when the honeypot field is filled (default true). */
  honeypot?: boolean;
  /** Require the signed form-start token to be ≥ FORM_MIN_AGE_MS old (default true). */
  minFormAge?: boolean;
  /** Postgres rate limits; IP limits run before parsing, input-keyed ones after. */
  limits?: PublicLimit<I>[];
  name?: string;
}

/**
 * Wraps public Server Actions (checkout, requests, cancellation): honeypot → minimum form age →
 * IP rate limits → zod (locale-aware messages) → input-keyed limits → handler → effects
 * (spec §5.1 step 1, §7 Abuse).
 */
export function publicAction<S extends z.ZodType, T>(
  schema: S,
  handler: (
    input: z.output<S>,
    meta: PublicActionMeta,
  ) => Promise<ServiceResult<T>>,
  opts: PublicActionOptions<z.output<S>> = {},
): (prev: ActionState<T>, payload: Payload) => Promise<ActionState<T>> {
  return async (_prev, payload) => {
    const raw = toObject(payload);
    const locale = parseLocale(raw);
    if (!locale || !isLocale(locale)) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", formErrors: ["locale"] },
      };
    }
    try {
      if (opts.honeypot !== false) {
        const trap = raw[HONEYPOT_FIELD];
        if (typeof trap === "string" && trap.trim() !== "") {
          return { ok: false, error: { code: "SPAM" } };
        }
      }
      if (opts.minFormAge !== false && env.FORM_MIN_AGE_MS > 0) {
        const token = raw[FORM_START_FIELD];
        const age = formAgeMs(typeof token === "string" ? token : null);
        if (age === null || age < env.FORM_MIN_AGE_MS) {
          return { ok: false, error: { code: "TOO_FAST" } };
        }
      }
      const ipHash = ipHashFrom(await headers());
      const limits = opts.limits ?? [];
      for (const l of limits) {
        if (l.by !== "ip") continue;
        const r = await checkLimit(l.name, ipHash ?? "unknown-ip");
        if (!r.allowed) {
          return {
            ok: false,
            error: { code: "RATE_LIMITED", retryAfterSec: r.retryAfterSec },
          };
        }
      }
      const parsed = schema.safeParse(raw, { error: zodErrorMap(locale) });
      if (!parsed.success) return invalid(parsed.error);
      for (const l of limits) {
        if (l.by === "ip") continue;
        const subject = l.by(parsed.data);
        if (!subject) continue;
        const r = await checkLimit(l.name, subject);
        if (!r.allowed) {
          return {
            ok: false,
            error: { code: "RATE_LIMITED", retryAfterSec: r.retryAfterSec },
          };
        }
      }
      const { result, effects } = await handler(parsed.data, {
        locale,
        ipHash,
      });
      applyEffects(effects);
      return { ok: true, data: result };
    } catch (error) {
      return handleFailure(error, opts.name ?? "public");
    }
  };
}
