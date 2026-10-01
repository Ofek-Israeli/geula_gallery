import "server-only";
import { z } from "zod";

/**
 * The only module in src/server that reads `process.env` (spec §2.2, §4.8).
 *
 * - `parseEnv(source)` is pure and unit-testable.
 * - `env` is parsed once at import; `instrumentation.ts` imports this module so a bad
 *   configuration fails at boot. Error messages name variables, never their values.
 */

const emptyToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const str = () => z.preprocess(emptyToUndefined, z.string().trim());
const optStr = () =>
  z.preprocess(emptyToUndefined, z.string().trim().optional());
const url = () => z.preprocess(emptyToUndefined, z.url());
const optUrl = () => z.preprocess(emptyToUndefined, z.url().optional());
const bool = (def: boolean) =>
  z.preprocess((v) => {
    const s = emptyToUndefined(v);
    if (s === undefined) return def;
    if (typeof s === "string") {
      const lower = s.toLowerCase();
      if (["1", "true", "yes", "on"].includes(lower)) return true;
      if (["0", "false", "no", "off"].includes(lower)) return false;
    }
    return s;
  }, z.boolean());
const int = (def: number) =>
  z.preprocess(
    (v) => emptyToUndefined(v) ?? def,
    z.coerce.number().int().nonnegative(),
  );
const num = (def: number) =>
  z.preprocess((v) => emptyToUndefined(v) ?? def, z.coerce.number().positive());
const csv = <T extends string>(values: readonly [T, ...T[]], def: T[]) =>
  z.preprocess(
    (v) => {
      const s = emptyToUndefined(v);
      if (s === undefined) return def;
      if (typeof s !== "string") return s;
      return s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    },
    z.array(z.enum(values)),
  );
const secret = (min: number) =>
  z.preprocess(
    emptyToUndefined,
    z.string().min(min, `must be at least ${min} characters`),
  );

const PROVIDER_MODE = ["disabled", "test", "live"] as const;
const SANDBOX_MODE = ["disabled", "sandbox", "live"] as const;

const rawSchema = z.object({
  // Core
  APP_ENV: z.preprocess(
    (v) => emptyToUndefined(v) ?? "development",
    z.enum(["development", "test", "production"]),
  ),
  APP_URL: url(),
  PUBLIC_WEBHOOK_BASE_URL: optUrl(),
  APP_SECRET: secret(32),
  /** base64 or base64url encoding of exactly 32 random bytes (AES-256-GCM). */
  PII_ENCRYPTION_KEY: str(),
  DEMO_MODE: bool(false),
  NEXT_DIST_DIR: optStr(),

  // Database
  DATABASE_URL: url(),
  DATABASE_URL_UNPOOLED: optUrl(),
  TEST_DATABASE_URL: optUrl(),
  E2E_DATABASE_URL: optUrl(),
  E2E_PORT: int(3100),

  // Auth
  BETTER_AUTH_SECRET: secret(32),
  BETTER_AUTH_URL: optUrl(),
  ADMIN_REQUIRE_2FA: bool(false),
  ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.email().optional()),
  SEED_E2E_USERS: bool(false),

  // Abuse
  RATE_LIMIT_SCALE: num(1),
  FORM_MIN_AGE_MS: int(3000),

  // Cron
  CRON_SECRET: secret(16),

  // Payments
  PAYMENT_PROVIDERS: csv(["mock", "cardcom", "paypal"] as const, ["mock"]),
  MOCK_WEBHOOK_SECRET: secret(16),
  MOCK_PAYMENT_FLOW: z.preprocess(
    (v) => emptyToUndefined(v) ?? "direct",
    z.enum(["direct", "capture"]),
  ),

  // Cardcom
  CARDCOM_MODE: z.preprocess(
    (v) => emptyToUndefined(v) ?? "disabled",
    z.enum(PROVIDER_MODE),
  ),
  CARDCOM_BASE_URL: z.preprocess(
    (v) => emptyToUndefined(v) ?? "https://secure.cardcom.solutions",
    z.url(),
  ),
  CARDCOM_TERMINAL_NUMBER: optStr(),
  CARDCOM_API_NAME: optStr(),
  CARDCOM_API_PASSWORD: optStr(),
  CARDCOM_CURRENCIES: csv(["ILS", "USD"] as const, ["ILS"]),
  CARDCOM_3DS: z.preprocess(
    (v) => emptyToUndefined(v) ?? "Enabled",
    z.enum(["Enabled", "Disabled", "Auto"]),
  ),
  CARDCOM_WALLETS: csv(["bit", "applepay", "googlepay"] as const, []),
  CARDCOM_LATE_WATCH_HOURS: int(72),
  CARDCOM_TAIL_DAYS: int(30),

  // PayPal
  PAYPAL_MODE: z.preprocess(
    (v) => emptyToUndefined(v) ?? "disabled",
    z.enum(SANDBOX_MODE),
  ),
  PAYPAL_CLIENT_ID: optStr(),
  PAYPAL_CLIENT_SECRET: optStr(),
  PAYPAL_WEBHOOK_ID: optStr(),
  PAYPAL_MERCHANT_ID: optStr(),

  // Tax documents
  TAX_DOCUMENTS_MODE: z.preprocess(
    (v) => emptyToUndefined(v) ?? "mock",
    z.enum(["mock", "morning", "gateway", "none"]),
  ),
  MORNING_MODE: z.preprocess(
    (v) => emptyToUndefined(v) ?? "disabled",
    z.enum(SANDBOX_MODE),
  ),
  MORNING_CLIENT_ID: optStr(),
  MORNING_CLIENT_SECRET: optStr(),

  // Shipping
  SHIPPING_CARRIER: z.preprocess(
    (v) => emptyToUndefined(v) ?? "mock",
    z.enum(["mock", "manual", "dhl"]),
  ),
  DHL_EXPRESS_MODE: z.preprocess(
    (v) => emptyToUndefined(v) ?? "disabled",
    z.enum(PROVIDER_MODE),
  ),
  DHL_API_KEY: optStr(),
  DHL_API_SECRET: optStr(),
  DHL_ACCOUNT_NUMBER: optStr(),
  DHL_PAPERLESS_TRADE: bool(false),
  DHL_OPENAPI_URL: optUrl(),
  MOCK_CARRIER_DELIVERY_SECONDS: int(300),

  // Email
  EMAIL_DRIVER: z.preprocess(
    (v) => emptyToUndefined(v) ?? "log",
    z.enum(["log", "resend"]),
  ),
  RESEND_API_KEY: optStr(),
  EMAIL_FROM: z.preprocess(
    (v) => emptyToUndefined(v) ?? "Geula Gallery <studio@example.com>",
    z.string(),
  ),
  EMAIL_REPLY_TO: z.preprocess(emptyToUndefined, z.email().optional()),

  // Storage
  STORAGE_DRIVER: z.preprocess(
    (v) => emptyToUndefined(v) ?? "local",
    z.enum(["local", "blob"]),
  ),
  LOCAL_STORAGE_DIR: z.preprocess(
    (v) => emptyToUndefined(v) ?? ".data/uploads",
    z.string(),
  ),
  BLOB_READ_WRITE_TOKEN: optStr(),
  BLOB_PRIVATE_READ_WRITE_TOKEN: optStr(),
  NEXT_PUBLIC_BLOB_HOST: optStr(),

  // Demo
  AIC_USER_AGENT: z.preprocess(
    (v) =>
      emptyToUndefined(v) ??
      "geula-gallery-demo (https://github.com/Ofek-Israeli/geula_gallery)",
    z.string(),
  ),

  // Opt-in live checks
  CARDCOM_CONTRACT: bool(false),
  PAYPAL_CONTRACT: bool(false),
  MORNING_CONTRACT: bool(false),
  DHL_CONTRACT: bool(false),
  RECORD_FIXTURES: bool(false),
});

type RawEnv = z.infer<typeof rawSchema>;

function decodeKey(value: string): Buffer | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const buf = Buffer.from(normalized, "base64");
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

function addCrossFieldIssues(e: RawEnv, ctx: z.RefinementCtx): void {
  const issue = (path: keyof RawEnv, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });

  const isProduction = e.APP_ENV === "production";
  const appUrl = new URL(e.APP_URL);

  if (!decodeKey(e.PII_ENCRYPTION_KEY)) {
    issue("PII_ENCRYPTION_KEY", "must be base64 of exactly 32 bytes");
  }

  // DEMO_MODE=true ⇒ no live provider.
  if (e.DEMO_MODE) {
    for (const key of [
      "CARDCOM_MODE",
      "PAYPAL_MODE",
      "MORNING_MODE",
      "DHL_EXPRESS_MODE",
    ] as const) {
      if (e[key] === "live") issue(key, "must not be live when DEMO_MODE=true");
    }
  }

  // Production policy that applies with or without demo mode.
  if (isProduction) {
    if (e.RATE_LIMIT_SCALE !== 1)
      issue("RATE_LIMIT_SCALE", "must be 1 in production");
    if (e.FORM_MIN_AGE_MS < 3000)
      issue("FORM_MIN_AGE_MS", "must be >= 3000 in production");
    for (const key of [
      "APP_SECRET",
      "BETTER_AUTH_SECRET",
      "CRON_SECRET",
      "MOCK_WEBHOOK_SECRET",
    ] as const) {
      if (e[key].length < 32)
        issue(key, "must be at least 32 characters in production");
    }
  }

  // Real production store.
  if (isProduction && !e.DEMO_MODE) {
    if (e.PAYMENT_PROVIDERS.includes("mock"))
      issue("PAYMENT_PROVIDERS", "must not include mock in production");
    if (
      e.TAX_DOCUMENTS_MODE !== "morning" &&
      e.TAX_DOCUMENTS_MODE !== "gateway"
    )
      issue("TAX_DOCUMENTS_MODE", "must be morning or gateway in production");
    if (e.SHIPPING_CARRIER === "mock")
      issue("SHIPPING_CARRIER", "must not be mock in production");
    if (e.EMAIL_DRIVER !== "resend")
      issue("EMAIL_DRIVER", "must be resend in production");
    if (e.STORAGE_DRIVER !== "blob")
      issue("STORAGE_DRIVER", "must be blob in production");
  }

  if (e.PAYMENT_PROVIDERS.length === 0)
    issue("PAYMENT_PROVIDERS", "must list at least one provider");
  if (e.PAYMENT_PROVIDERS.includes("cardcom") && e.CARDCOM_MODE === "disabled")
    issue("PAYMENT_PROVIDERS", "lists cardcom but CARDCOM_MODE=disabled");
  if (e.PAYMENT_PROVIDERS.includes("paypal") && e.PAYPAL_MODE === "disabled")
    issue("PAYMENT_PROVIDERS", "lists paypal but PAYPAL_MODE=disabled");

  // Cardcom
  if (e.CARDCOM_MODE !== "disabled") {
    if (!e.CARDCOM_TERMINAL_NUMBER)
      issue("CARDCOM_TERMINAL_NUMBER", "required when CARDCOM_MODE is enabled");
    if (!e.CARDCOM_API_NAME)
      issue("CARDCOM_API_NAME", "required when CARDCOM_MODE is enabled");
  }
  if (e.CARDCOM_MODE === "live") {
    if (!e.CARDCOM_API_PASSWORD)
      issue("CARDCOM_API_PASSWORD", "required when CARDCOM_MODE=live");
    if (e.DEMO_MODE) issue("CARDCOM_MODE", "live requires DEMO_MODE=false");
  }
  if (e.TAX_DOCUMENTS_MODE === "gateway" && e.CARDCOM_MODE !== "live") {
    issue(
      "TAX_DOCUMENTS_MODE",
      "gateway requires CARDCOM_MODE=live (the test terminal cannot issue documents)",
    );
  }

  // PayPal
  if (e.PAYPAL_MODE !== "disabled") {
    if (!e.PAYPAL_MERCHANT_ID)
      issue("PAYPAL_MERCHANT_ID", "required when PAYPAL_MODE is enabled");
    if (!e.PAYPAL_CLIENT_ID)
      issue("PAYPAL_CLIENT_ID", "required when PAYPAL_MODE is enabled");
    if (!e.PAYPAL_CLIENT_SECRET)
      issue("PAYPAL_CLIENT_SECRET", "required when PAYPAL_MODE is enabled");
  }

  // Morning
  if (e.TAX_DOCUMENTS_MODE === "morning" && e.MORNING_MODE === "disabled")
    issue("MORNING_MODE", "must be enabled when TAX_DOCUMENTS_MODE=morning");
  if (e.MORNING_MODE !== "disabled") {
    if (!e.MORNING_CLIENT_ID)
      issue("MORNING_CLIENT_ID", "required when MORNING_MODE is enabled");
    if (!e.MORNING_CLIENT_SECRET)
      issue("MORNING_CLIENT_SECRET", "required when MORNING_MODE is enabled");
  }

  // DHL
  if (e.SHIPPING_CARRIER === "dhl" && e.DHL_EXPRESS_MODE === "disabled")
    issue("DHL_EXPRESS_MODE", "must be enabled when SHIPPING_CARRIER=dhl");
  if (e.DHL_EXPRESS_MODE !== "disabled") {
    for (const key of [
      "DHL_API_KEY",
      "DHL_API_SECRET",
      "DHL_ACCOUNT_NUMBER",
    ] as const) {
      if (!e[key]) issue(key, "required when DHL_EXPRESS_MODE is enabled");
    }
  }

  // Email and storage drivers
  if (e.EMAIL_DRIVER === "resend" && !e.RESEND_API_KEY)
    issue("RESEND_API_KEY", "required when EMAIL_DRIVER=resend");
  if (e.STORAGE_DRIVER === "blob") {
    if (!e.BLOB_READ_WRITE_TOKEN)
      issue("BLOB_READ_WRITE_TOKEN", "required when STORAGE_DRIVER=blob");
    if (!e.BLOB_PRIVATE_READ_WRITE_TOKEN)
      issue(
        "BLOB_PRIVATE_READ_WRITE_TOKEN",
        "required when STORAGE_DRIVER=blob",
      );
  }

  // APP_ENV=test ⇒ derived/explicit auth and webhook hosts equal APP_URL's host
  // (catches a leaked .env.local value overriding the E2E server's env).
  if (e.APP_ENV === "test") {
    for (const key of ["BETTER_AUTH_URL", "PUBLIC_WEBHOOK_BASE_URL"] as const) {
      const value = e[key];
      if (value && new URL(value).host !== appUrl.host)
        issue(key, "host must equal APP_URL's host when APP_ENV=test");
    }
  }
}

const envSchema = rawSchema.superRefine(addCrossFieldIssues).transform((e) => {
  const appUrl = e.APP_URL.replace(/\/+$/, "");
  const httpsApp = appUrl.startsWith("https://");
  return {
    ...e,
    APP_URL: appUrl,
    PUBLIC_WEBHOOK_BASE_URL: (e.PUBLIC_WEBHOOK_BASE_URL ?? appUrl).replace(
      /\/+$/,
      "",
    ),
    BETTER_AUTH_URL: (e.BETTER_AUTH_URL ?? appUrl).replace(/\/+$/, ""),
    DATABASE_URL_UNPOOLED: e.DATABASE_URL_UNPOOLED ?? e.DATABASE_URL,
    // Forced on for any https deployment or production (spec §4.8, §7).
    ADMIN_REQUIRE_2FA:
      e.ADMIN_REQUIRE_2FA || httpsApp || e.APP_ENV === "production",
    PII_ENCRYPTION_KEY_BYTES:
      decodeKey(e.PII_ENCRYPTION_KEY) ?? Buffer.alloc(0),
    isProduction: e.APP_ENV === "production",
  };
});

export type Env = z.output<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "EnvError";
  }
}

/** Pure: parse and validate an env-like record. Throws `EnvError` (names only, never values). */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

export const env: Env = parseEnv(process.env);
