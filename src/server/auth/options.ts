// Pure Better Auth options factory (spec §2.2, §6.10).
// Deliberately NOT `server-only`, never imports `next/*` and never reads `process.env`: it is shared
// by the Next layer (`src/server/next/auth.ts`, which appends `nextCookies()`), the auth CLI
// (`scripts/auth-cli.ts`) and `scripts/admin-create.ts`. Everything environment-specific is passed in.
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins/two-factor";

export const AUTH_ISSUER = "Geula Gallery";
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Better Auth database rate limits (spec §7: 5 per 15 min on sign-in and TOTP verification).
 * Backup-code verification gets the same limit (M1 step 9 addition): it is a second factor too.
 */
export const AUTH_RATE_LIMIT_RULES = {
  "/sign-in/email": { window: 900, max: 5 },
  "/two-factor/verify-totp": { window: 900, max: 5 },
  "/two-factor/verify-backup-code": { window: 900, max: 5 },
} as const;

export interface CreateAuthOptionsInput {
  /** A drizzle (node-postgres) database instance. */
  // biome-ignore lint/suspicious/noExplicitAny: the drizzle adapter accepts any drizzle db.
  db: any;
  /** Auth table objects (`src/server/db/schema/auth.ts`); omit only for CLI schema generation. */
  schema?: Record<string, unknown>;
  secret: string;
  baseURL: string;
  /** Only `scripts/admin-create.ts` enables sign-up; the app never does. */
  allowSignUp?: boolean;
  /** Request hooks (e.g. the failed-sign-in recorder added in M1 step 9). */
  hooks?: BetterAuthOptions["hooks"];
  /**
   * Atomic rate-limit storage. The app passes one backed by our `rate_limits` table with
   * HMAC-hashed keys (spec §7: IPs are stored only as hashes). Without it, Better Auth's own
   * `rate_limit` table is used (scripts never serve HTTP, so they never hit it).
   */
  rateLimitStorage?: NonNullable<
    BetterAuthOptions["rateLimit"]
  >["customStorage"];
  /** Database hooks (the app hashes `session.ip_address`). */
  databaseHooks?: BetterAuthOptions["databaseHooks"];
}

export function createAuthOptions(input: CreateAuthOptionsInput) {
  return {
    appName: AUTH_ISSUER,
    secret: input.secret,
    baseURL: input.baseURL,
    trustedOrigins: [input.baseURL],
    database: drizzleAdapter(input.db, {
      provider: "pg",
      ...(input.schema ? { schema: input.schema } : {}),
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !input.allowSignUp,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: { ...AUTH_RATE_LIMIT_RULES },
      ...(input.rateLimitStorage
        ? { customStorage: input.rateLimitStorage }
        : {}),
    },
    // The Next layer spreads these options and appends `nextCookies()` last (spec §6.10).
    plugins: [twoFactor({ issuer: AUTH_ISSUER })],
    ...(input.hooks ? { hooks: input.hooks } : {}),
    ...(input.databaseHooks ? { databaseHooks: input.databaseHooks } : {}),
  } satisfies BetterAuthOptions;
}
