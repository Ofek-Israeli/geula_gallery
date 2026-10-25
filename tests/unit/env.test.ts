import { describe, expect, it } from "vitest";
import { applyTestEnv, testEnv } from "../helpers/db";

/**
 * `parseEnv` derivations and the spec §4.8 cross-field rules. `@/server/env` parses
 * `process.env` at import, so a valid test env is applied before the dynamic import.
 */
applyTestEnv();
const { parseEnv, EnvError } = await import("@/server/env");

const LONG = "x".repeat(40);

/** A valid real-store production configuration (no demo, real providers). */
function productionEnv(): Record<string, string> {
  return {
    ...testEnv(),
    APP_ENV: "production",
    APP_URL: "https://gallery.example.com",
    DEMO_MODE: "false",
    APP_SECRET: LONG,
    BETTER_AUTH_SECRET: LONG,
    CRON_SECRET: LONG,
    MOCK_WEBHOOK_SECRET: LONG,
    FORM_MIN_AGE_MS: "3000",
    PAYMENT_PROVIDERS: "cardcom",
    CARDCOM_MODE: "live",
    CARDCOM_TERMINAL_NUMBER: "1000",
    CARDCOM_API_NAME: "placeholder-name",
    CARDCOM_API_PASSWORD: "placeholder-password",
    TAX_DOCUMENTS_MODE: "gateway",
    SHIPPING_CARRIER: "manual",
    EMAIL_DRIVER: "resend",
    RESEND_API_KEY: "placeholder-resend",
    STORAGE_DRIVER: "blob",
    BLOB_READ_WRITE_TOKEN: "placeholder-blob",
    BLOB_PRIVATE_READ_WRITE_TOKEN: "placeholder-blob-private",
    NEXT_PUBLIC_BLOB_HOST: "store.public.blob.vercel-storage.com",
  };
}

/**
 * The showcase launch (docs/architecture.md "Showcase launch"): production with online sales
 * closed and emails only to the painter; no payment provider, tax documents or carrier.
 */
function showcaseEnv(): Record<string, string> {
  return {
    ...productionEnv(),
    SALES_OPEN: "false",
    EMAIL_TO_VISITORS: "false",
    PAYMENT_PROVIDERS: "",
    CARDCOM_MODE: "disabled",
    CARDCOM_TERMINAL_NUMBER: "",
    CARDCOM_API_NAME: "",
    CARDCOM_API_PASSWORD: "",
    TAX_DOCUMENTS_MODE: "none",
    SHIPPING_CARRIER: "manual",
  };
}

function problems(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return (error as InstanceType<typeof EnvError>).problems;
  }
}

function expectProblem(
  source: Record<string, string | undefined>,
  variable: string,
): void {
  const found = problems(source);
  expect(
    found.some((p) => p.startsWith(`${variable}:`)),
    `expected a problem for ${variable}, got: ${found.join(" | ")}`,
  ).toBe(true);
}

describe("parseEnv derivations", () => {
  it("accepts the pinned test env and derives URLs from APP_URL", () => {
    const env = parseEnv({ ...testEnv(), APP_URL: "http://localhost:3000/" });
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:3000");
    expect(env.PUBLIC_WEBHOOK_BASE_URL).toBe("http://localhost:3000");
    expect(env.DATABASE_URL_UNPOOLED).toBe(env.DATABASE_URL);
    expect(env.ADMIN_REQUIRE_2FA).toBe(false);
    expect(env.PII_ENCRYPTION_KEY_BYTES.length).toBe(32);
    expect(env.isProduction).toBe(false);
  });

  it("forces 2FA for https deployments and production", () => {
    expect(
      parseEnv({
        ...testEnv(),
        APP_ENV: "development",
        APP_URL: "https://preview.example.com",
      }).ADMIN_REQUIRE_2FA,
    ).toBe(true);
    const prod = parseEnv({ ...productionEnv(), ADMIN_REQUIRE_2FA: "false" });
    expect(prod.ADMIN_REQUIRE_2FA).toBe(true);
    expect(prod.isProduction).toBe(true);
  });

  it("names variables but never echoes their values", () => {
    const secret = "test-value-that-must-never-be-echoed";
    const found = problems({
      ...productionEnv(),
      APP_SECRET: secret.slice(0, 10),
      PII_ENCRYPTION_KEY: secret,
    });
    expect(found.length).toBeGreaterThan(0);
    expect(found.join("\n")).not.toContain(secret.slice(0, 10));
  });
});

describe("parseEnv cross-field rules (spec §4.8)", () => {
  it("accepts a complete real production configuration", () => {
    expect(problems(productionEnv())).toEqual([]);
  });

  it("DEMO_MODE=true forbids any live provider", () => {
    expectProblem(
      {
        ...testEnv(),
        DEMO_MODE: "true",
        PAYMENT_PROVIDERS: "cardcom",
        CARDCOM_MODE: "live",
        CARDCOM_TERMINAL_NUMBER: "1000",
        CARDCOM_API_NAME: "placeholder-name",
        CARDCOM_API_PASSWORD: "placeholder-password",
      },
      "CARDCOM_MODE",
    );
  });

  it("a real production store rejects mock and dev-only drivers", () => {
    expectProblem(
      { ...productionEnv(), PAYMENT_PROVIDERS: "cardcom,mock" },
      "PAYMENT_PROVIDERS",
    );
    expectProblem(
      { ...productionEnv(), TAX_DOCUMENTS_MODE: "mock" },
      "TAX_DOCUMENTS_MODE",
    );
    expectProblem(
      { ...productionEnv(), SHIPPING_CARRIER: "mock" },
      "SHIPPING_CARRIER",
    );
    expectProblem({ ...productionEnv(), EMAIL_DRIVER: "log" }, "EMAIL_DRIVER");
    expectProblem(
      { ...productionEnv(), VERCEL: "1", STORAGE_DRIVER: "local" },
      "STORAGE_DRIVER",
    );
    // A self-hosted server keeps files on its own disk.
    expect(
      problems({ ...productionEnv(), STORAGE_DRIVER: "local" }).filter((p) =>
        p.startsWith("STORAGE_DRIVER"),
      ),
    ).toEqual([]);
    expectProblem({ ...productionEnv(), APP_SECRET: "short" }, "APP_SECRET");
    expectProblem(
      { ...productionEnv(), RATE_LIMIT_SCALE: "100" },
      "RATE_LIMIT_SCALE",
    );
    expectProblem(
      { ...productionEnv(), FORM_MIN_AGE_MS: "0" },
      "FORM_MIN_AGE_MS",
    );
  });

  it("CARDCOM_MODE=live needs the ApiPassword and DEMO_MODE=false", () => {
    expectProblem(
      { ...productionEnv(), CARDCOM_API_PASSWORD: "" },
      "CARDCOM_API_PASSWORD",
    );
  });

  it("the Cardcom test terminal cannot be the tax-document gateway", () => {
    expectProblem(
      {
        ...testEnv(),
        PAYMENT_PROVIDERS: "cardcom",
        CARDCOM_MODE: "test",
        CARDCOM_TERMINAL_NUMBER: "1000",
        CARDCOM_API_NAME: "placeholder-name",
        TAX_DOCUMENTS_MODE: "gateway",
      },
      "TAX_DOCUMENTS_MODE",
    );
  });

  it("PAYPAL_MODE enabled requires PAYPAL_MERCHANT_ID", () => {
    expectProblem(
      {
        ...testEnv(),
        PAYPAL_MODE: "sandbox",
        PAYPAL_CLIENT_ID: "placeholder-id",
        PAYPAL_CLIENT_SECRET: "placeholder-secret",
      },
      "PAYPAL_MERCHANT_ID",
    );
  });

  it("APP_ENV=test pins auth and webhook hosts to APP_URL's host", () => {
    expectProblem(
      { ...testEnv(), BETTER_AUTH_URL: "http://localhost:3999" },
      "BETTER_AUTH_URL",
    );
    expectProblem(
      { ...testEnv(), PUBLIC_WEBHOOK_BASE_URL: "https://tunnel.example.com" },
      "PUBLIC_WEBHOOK_BASE_URL",
    );
  });

  it("rejects a PII key that is not 32 bytes", () => {
    expectProblem(
      { ...testEnv(), PII_ENCRYPTION_KEY: "test-too-short" },
      "PII_ENCRYPTION_KEY",
    );
  });

  it("blob storage needs the public store's host", () => {
    expectProblem(
      { ...productionEnv(), NEXT_PUBLIC_BLOB_HOST: "" },
      "NEXT_PUBLIC_BLOB_HOST",
    );
  });
});

describe("the showcase switches", () => {
  it("default to an open store that emails visitors", () => {
    const e = parseEnv(testEnv());
    expect(e.SALES_OPEN).toBe(true);
    expect(e.EMAIL_TO_VISITORS).toBe(true);
    expect(e.GOOGLE_SITE_VERIFICATION).toBeUndefined();
  });

  it("a showcase production needs no payment, tax-document or carrier setup", () => {
    expect(problems(showcaseEnv())).toEqual([]);
    const e = parseEnv({ ...showcaseEnv(), GOOGLE_SITE_VERIFICATION: "abc" });
    expect(e.SALES_OPEN).toBe(false);
    expect(e.EMAIL_TO_VISITORS).toBe(false);
    expect(e.GOOGLE_SITE_VERIFICATION).toBe("abc");
    // Mock is the parsed default, but production outside demo mode never builds it.
    expect(e.PAYMENT_PROVIDERS).toEqual(["mock"]);
  });

  it("a showcase production may keep emails in the database; Blob on Vercel and strong secrets stay", () => {
    expect(
      problems({ ...showcaseEnv(), EMAIL_DRIVER: "log", RESEND_API_KEY: "" }),
    ).toEqual([]);
    expectProblem(
      { ...showcaseEnv(), VERCEL: "1", STORAGE_DRIVER: "local" },
      "STORAGE_DRIVER",
    );
    expectProblem(
      { ...showcaseEnv(), CRON_SECRET: "x".repeat(20) },
      "CRON_SECRET",
    );
  });

  it("opening sales brings back the real-store rules", () => {
    const open = { ...showcaseEnv(), SALES_OPEN: "true" };
    expectProblem(open, "PAYMENT_PROVIDERS");
    expectProblem({ ...open, EMAIL_DRIVER: "log" }, "EMAIL_DRIVER");
    // Receipts by hand (`none`) stay allowed once sales open; mock documents never are.
    expect(
      problems(open).some((p) => p.startsWith("TAX_DOCUMENTS_MODE:")),
    ).toBe(false);
    expectProblem(
      { ...open, TAX_DOCUMENTS_MODE: "mock" },
      "TAX_DOCUMENTS_MODE",
    );
  });

  it("the checkout preview is a showcase production with the purchase flow public", () => {
    const preview = { ...showcaseEnv(), CHECKOUT_PREVIEW: "true" };
    // Like the showcase: no payment, tax-document, carrier or email setup is needed.
    expect(problems(preview)).toEqual([]);
    expect(parseEnv(preview).salesAccess).toBe("preview");
    expect(parseEnv(showcaseEnv()).salesAccess).toBe("closed");
    expect(parseEnv(testEnv()).salesAccess).toBe("open");
    expect(parseEnv(testEnv()).CHECKOUT_PREVIEW).toBe(false);
  });

  it("an open production store lists live providers only (test payments never sell)", () => {
    expect(problems(productionEnv())).toEqual([]);
    expectProblem({ ...productionEnv(), CARDCOM_MODE: "test" }, "CARDCOM_MODE");
    // The preview may use a test terminal.
    expect(
      problems({
        ...showcaseEnv(),
        CHECKOUT_PREVIEW: "true",
        PAYMENT_PROVIDERS: "cardcom",
        CARDCOM_MODE: "test",
        CARDCOM_TERMINAL_NUMBER: "1000",
        CARDCOM_API_NAME: "test-api-name",
      }),
    ).toEqual([]);
  });

  it("the preview is only for a store whose sales are closed", () => {
    expectProblem(
      { ...testEnv(), SALES_OPEN: "true", CHECKOUT_PREVIEW: "true" },
      "CHECKOUT_PREVIEW",
    );
  });
});
