import "server-only";
import { betterAuth } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { createAuthOptions } from "@/server/auth/options";
import { db } from "@/server/db/client";
import * as authSchema from "@/server/db/schema/auth";
import { env } from "@/server/env";
import { log } from "@/server/log";
import {
  authRateLimitStorage,
  hashSessionIp,
} from "@/server/security/auth-privacy";
import { ipHashFrom } from "@/server/security/ip";
import { recordFailedSignIn } from "@/server/security/sign-in-failures";

/** Endpoints whose failures are audited (and counted for the daily alert). */
const AUDITED_FAILURE_PATHS = new Set([
  "/sign-in/email",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

const options = createAuthOptions({
  db,
  schema: authSchema,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  rateLimitStorage: authRateLimitStorage,
  databaseHooks: {
    session: {
      create: { before: hashSessionIp },
      update: { before: hashSessionIp },
    },
  },
  hooks: {
    // Spec §6.10: an after-hook records failed sign-ins (audited; daily alert above 10).
    after: createAuthMiddleware(async (ctx) => {
      if (!AUDITED_FAILURE_PATHS.has(ctx.path)) return;
      const returned = ctx.context.returned;
      if (!isAPIError(returned)) return;
      const body = (ctx.body ?? {}) as { email?: unknown };
      try {
        await recordFailedSignIn({
          email: typeof body.email === "string" ? body.email : null,
          path: ctx.path,
          status: returned.statusCode,
          ipHash: ctx.headers ? ipHashFrom(ctx.headers) : null,
        });
      } catch (error) {
        // Never turn a failed sign-in into a 500 because auditing failed.
        log.error("auth.failed_sign_in_audit_error", { path: ctx.path }, error);
      }
    }),
  },
});

/**
 * The app's Better Auth instance (spec §6.10). `nextCookies()` must be the last plugin so cookies
 * set by `auth.api.*` calls inside Server Actions reach the browser.
 */
export const auth = betterAuth({
  ...options,
  plugins: [...options.plugins, nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;
