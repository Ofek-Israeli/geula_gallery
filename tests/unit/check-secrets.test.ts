import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  CARDCOM_TEST_API_NAME_SHA256,
  isAllowlistedEmail,
  isAllowlistedId,
  isAllowlistedPhone,
  mask,
  scanPatch,
  scanPath,
  scanText,
} from "../../scripts/check-secrets";

/**
 * Spec §7 / §10.1 `check-secrets`. Secret-shaped strings are assembled at runtime so this file
 * never contains one literally (push protection and the scanner itself stay quiet).
 */
const j = (...parts: string[]) => parts.join("");
const rules = (file: string, text: string) =>
  scanText(file, text).map((f) => f.rule);

describe("token rules", () => {
  it("flags GitHub tokens", () => {
    expect(
      rules("src/a.ts", `const t = "${j("gh", "p_", "A1b2".repeat(9))}";`),
    ).toContain("github-token");
    expect(rules("src/a.ts", j("github", "_pat_", "x".repeat(30)))).toContain(
      "github-pat",
    );
  });

  it("flags PEM private keys", () => {
    const pem = j("-----BEGIN ", "RSA PRIVATE KEY", "-----");
    expect(rules("docs/x.md", pem)).toContain("pem-block");
    expect(rules("a.txt", j("-----BEGIN ", "PRIVATE KEY", "-----"))).toContain(
      "pem-block",
    );
  });

  it("flags Resend, sk_, Vercel Blob, AWS and Slack tokens", () => {
    expect(rules("a.ts", j("re", "_AbC123de_", "x9Y8z7W6v5U4t3S2"))).toContain(
      "resend-key",
    );
    expect(rules("a.ts", j("sk", "_live_", "Q".repeat(24)))).toContain(
      "sk-key",
    );
    expect(
      rules("a.ts", j("vercel", "_blob_rw_", "abcDEF123456_xyz")),
    ).toContain("vercel-blob-token");
    expect(rules("a.ts", j("AK", "IA", "ABCDEFGHIJKLMNOP"))).toContain(
      "aws-access-key",
    );
    expect(rules("a.ts", j("xo", "xb-", "1234567890-abcdef"))).toContain(
      "slack-token",
    );
  });

  it("does not flag ordinary code", () => {
    expect(
      rules(
        "src/a.ts",
        'const re_match = /x/; const sk = "sk"; import { createHash } from "node:crypto";',
      ),
    ).toEqual([]);
  });
});

describe("secret-like assignments", () => {
  it("flags quoted literals of 12+ characters", () => {
    expect(
      rules("src/a.ts", `const API_KEY = "${j("q8Zr", "4LmN2pXw")}";`),
    ).toEqual(["secret-assignment"]);
    expect(
      rules("x.json", `{ "clientSecret": "${j("s3cr3t", "V4lue99")}" }`),
    ).toEqual(["secret-assignment"]);
  });

  it("flags bare values in env, YAML and shell files", () => {
    expect(
      rules(".env.production", j("CRON_SECRET=", "r4nd0mV4lu3xyz")),
    ).toEqual(["secret-assignment"]);
    expect(rules("ci.yml", j("  API_TOKEN: ", "r4nd0mV4lu3xyz"))).toEqual([
      "secret-assignment",
    ]);
  });

  it("allows e2e-, test-, dev-only-, example and placeholder values", () => {
    for (const v of [
      "e2e-cron-secret-123",
      "test-app-secret-0123",
      "dev-only-secret-0123",
      "my-example-secret-1",
      "placeholder-generate-a-32-byte-secret",
    ]) {
      expect(rules("src/a.ts", `APP_SECRET: "${v}"`)).toEqual([]);
      expect(rules(".env.example", `APP_SECRET=${v}`)).toEqual([]);
    }
  });

  it("ignores short values, env-var names and references", () => {
    expect(rules("src/a.ts", 'const PASSWORD = "short";')).toEqual([]);
    expect(
      rules(
        "src/a.ts",
        j("throw new Error(`missing $", '{"BLOB_READ_WRITE_TOKEN"}`);'),
      ),
    ).toEqual([]);
    expect(
      rules("ci.yml", j("  API_TOKEN: $", "{{ secrets.API_TOKEN }}")),
    ).toEqual([]);
    expect(rules("src/a.ts", "const token = process.env.CRON_SECRET;")).toEqual(
      [],
    );
  });
});

describe("TLS kill switch", () => {
  const name = ["NODE", "TLS", "REJECT", "UNAUTHORIZED"].join("_");
  it("is flagged in code and config, not in prose", () => {
    expect(rules("scripts/x.ts", `process.env.${name} = "0";`)).toContain(
      "tls-verification-disabled",
    );
    expect(rules(".env.local", `${name}=0`)).toContain(
      "tls-verification-disabled",
    );
    expect(rules("docs/notes.md", `never set ${name}`)).toEqual([]);
  });
});

describe("hashed Cardcom test API name", () => {
  it("stores only SHA-256 hashes", () => {
    for (const h of CARDCOM_TEST_API_NAME_SHA256) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("finds a hashed token in any file, case-insensitively", () => {
    const fake = "FakeApiName42";
    const hashedNames = [
      createHash("sha256").update(fake.toLowerCase()).digest("hex"),
    ];
    const found = scanText("README.md", `ApiName: ${fake.toUpperCase()}`, {
      hashedNames,
    });
    expect(found.map((f) => f.rule)).toEqual(["cardcom-test-api-name"]);
    expect(found[0]?.preview).not.toContain(fake.toUpperCase());
    expect(
      scanText("README.md", "ApiName: SomethingElse", { hashedNames }),
    ).toEqual([]);
  });
});

describe("PII in fixtures and seeds (allowlist)", () => {
  it("has exactly the spec allowlist", () => {
    expect(ALLOWLIST).toEqual({
      ids: ["000000018"],
      emailDomains: ["example.com", "example.test"],
      emails: ["noreply@anthropic.com"],
      phones: ["03-000-0000", "+972-3-000-0000"],
    });
  });

  it("allows only the listed emails, phones and IDs", () => {
    expect(isAllowlistedEmail("painter@example.com")).toBe(true);
    expect(isAllowlistedEmail("Buyer@EXAMPLE.TEST")).toBe(true);
    expect(isAllowlistedEmail("noreply@anthropic.com")).toBe(true);
    expect(isAllowlistedEmail("someone@anthropic.com")).toBe(false);
    expect(isAllowlistedEmail("x@example.com.evil.io")).toBe(false);
    expect(isAllowlistedEmail("real.person@gmail.com")).toBe(false);
    expect(isAllowlistedPhone("03-000-0000")).toBe(true);
    expect(isAllowlistedPhone("+972-3-000-0000")).toBe(true);
    expect(isAllowlistedPhone("052-123-4567")).toBe(false);
    expect(isAllowlistedId("000000018")).toBe(true);
    expect(isAllowlistedId("123456782")).toBe(false);
  });

  it("flags PII only inside fixtures, seeds and data", () => {
    const text = [
      'email: "real.person@gmail.com",',
      'phone: "052-123-4567",',
      'idNumber: "123456782",',
      'ok: "painter@example.com", "03-000-0000", "000000018", "+972-3-000-0000"',
    ].join("\n");
    for (const file of [
      "scripts/seed/catalog.ts",
      "tests/fixtures/cardcom/x.json",
      "data/demo-manifest.json",
    ]) {
      expect(rules(file, text)).toEqual([
        "pii-email",
        "pii-phone",
        "pii-id-number",
      ]);
    }
    expect(rules("src/lib/phone.ts", text)).toEqual([]);
  });
});

describe("paths and history", () => {
  it("flags committed env and key files", () => {
    expect(scanPath(".env.local").map((f) => f.rule)).toEqual(["env-file"]);
    expect(scanPath("deploy/.env.production").map((f) => f.rule)).toEqual([
      "env-file",
    ]);
    expect(scanPath(".env.example")).toEqual([]);
    expect(scanPath("certs/server.pem").map((f) => f.rule)).toEqual([
      "key-file",
    ]);
  });

  it("scans only added lines of a patch, attributed to their file", () => {
    const token = j("gh", "p_", "Z9".repeat(18));
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      `-const old = "${token}";`,
      "+const fresh = 1;",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1 @@",
      `+const leaked = "${token}";`,
    ].join("\n");
    const found = scanPatch(patch);
    expect(found.map((f) => [f.file, f.rule])).toEqual([
      ["src/b.ts", "github-token"],
    ]);
  });

  it("masks previews", () => {
    expect(mask("abcdefghijkl")).toBe("abcd…(12 chars)");
    expect(mask("abc")).toBe("a…(3)");
  });
});
