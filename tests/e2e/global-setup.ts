import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type FullConfig, request } from "@playwright/test";
import { ADMIN_STORAGE_STATE, E2E_ADMIN } from "./e2e-env";

/**
 * Signs in once as the seeded E2E admin (`SEED_E2E_USERS=true`, no TOTP) and saves the session
 * cookies to `tests/e2e/.auth/admin.json` (spec §10.4). Admin specs opt in with
 * `test.use({ storageState: ADMIN_STORAGE_STATE })`. The web server is already up: Playwright
 * starts `webServer` before global setup.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("baseURL is not configured");
  const ctx = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
  });
  try {
    const res = await ctx.post("/api/auth/sign-in/email", {
      data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password },
    });
    if (!res.ok()) {
      throw new Error(
        `E2E admin sign-in failed: HTTP ${res.status()} (is SEED_E2E_USERS=true in the web server env?)`,
      );
    }
    mkdirSync(dirname(ADMIN_STORAGE_STATE), { recursive: true });
    await ctx.storageState({ path: ADMIN_STORAGE_STATE });
  } finally {
    await ctx.dispose();
  }
}
