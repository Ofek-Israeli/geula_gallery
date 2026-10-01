import { expect, type Page, test } from "@playwright/test";
import { msUntilNextWindow, secretFromTotpUri, totp } from "../helpers/totp";
import { E2E_ADMIN } from "./e2e-env";
import { HE } from "./support/admin";

/**
 * Spec §10.4 `admin-auth` (project `auth-limits`, runs after everything else): TOTP enrolment
 * from the account page, after which a new sign-in requires a code; and repeated bad sign-ins from
 * one address are throttled with 429. E2E runs with `RATE_LIMIT_SCALE=100`, so the 5-per-15-min
 * rule allows 5 × 100 attempts here; the spec exhausts that budget from its own address.
 */
const s = HE.shell;
const RATE_LIMIT_SCALE = 100;

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/he/admin/login");
  await page.getByLabel(new RegExp(`^${s.login.email}`)).fill(email);
  await page
    .getByLabel(new RegExp(`^${s.login.password}`))
    .fill(E2E_ADMIN.password);
  await expect(async () => {
    await page.getByRole("button", { name: s.login.submit }).click();
    await expect(page).not.toHaveURL(/\/admin\/login$/, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

async function freshCode(secret: string): Promise<string> {
  // A code is accepted once per window; wait for a new one if this one is about to expire.
  if (msUntilNextWindow() < 5_000)
    await new Promise((r) => setTimeout(r, msUntilNextWindow() + 250));
  return totp(secret);
}

test("TOTP enrolment on the account page → the next sign-in requires a code", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": "203.0.113.21" },
  });
  const page = await ctx.newPage();
  try {
    await signIn(page, E2E_ADMIN.totpEmail);
    await expect(page).toHaveURL(/\/he\/admin$/);

    await page.goto("/he/admin/account");
    const section = page.getByTestId("two-factor");
    await expect(section).toContainText(s.account.twoFactorOff);
    await section
      .getByLabel(new RegExp(`^${s.enroll.password}`))
      .fill(E2E_ADMIN.password);
    await expect(async () => {
      await section.getByRole("button", { name: s.enroll.start }).click();
      await expect(section.locator("code")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    const secret = ((await section.locator("code").textContent()) ?? "").trim();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
    await section
      .getByLabel(new RegExp(`^${s.enroll.code}`))
      .fill(await freshCode(secret));
    await section.getByRole("button", { name: s.enroll.verify }).click();
    await expect(page).toHaveURL(/\/he\/admin$/);
    await page.goto("/he/admin/account");
    await expect(page.getByTestId("two-factor")).toContainText(
      s.account.twoFactorOn,
    );

    // Sign out, sign in again: now a code is required.
    await ctx.clearCookies();
    await signIn(page, E2E_ADMIN.totpEmail);
    await expect(page).toHaveURL(/\/he\/admin\/login\/2fa/);
    await page.getByLabel(new RegExp(`^${s.twoFactor.code}`)).fill("000000");
    await page.getByRole("button", { name: s.twoFactor.submit }).click();
    await expect(page.getByText(s.twoFactor.invalid)).toBeVisible();
    // The next window's code (the enrolment code cannot be replayed).
    await new Promise((r) => setTimeout(r, msUntilNextWindow() + 250));
    await page
      .getByLabel(new RegExp(`^${s.twoFactor.code}`))
      .fill(totp(secret));
    await page.getByRole("button", { name: s.twoFactor.submit }).click();
    await expect(page).toHaveURL(/\/he\/admin$/);
    expect(secretFromTotpUri(`otpauth://totp/x?secret=${secret}`)).toBe(secret);
  } finally {
    await ctx.close();
  }
});

test("repeated bad sign-ins from one address → 429", async ({
  playwright,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: {
      Origin: baseURL ?? "",
      "x-forwarded-for": "203.0.113.99",
    },
  });
  try {
    const budget = 5 * RATE_LIMIT_SCALE;
    const attempt = () =>
      api.post("/api/auth/sign-in/email", {
        data: { email: E2E_ADMIN.email, password: "test-wrong-password" },
      });
    let refused = 0;
    for (let sent = 0; sent < budget; sent += 25) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(25, budget - sent) }, attempt),
      );
      refused += batch.filter((r) => r.status() === 429).length;
      for (const r of batch) expect([401, 429]).toContain(r.status());
    }
    const next = await attempt();
    expect(next.status()).toBe(429);
    expect(refused).toBeLessThanOrEqual(1);
    // The right password from the same address is throttled too, until the window ends.
    const right = await api.post("/api/auth/sign-in/email", {
      data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password },
    });
    expect(right.status()).toBe(429);
  } finally {
    await api.dispose();
  }
});
