/**
 * Entry point for the Better Auth CLI only (`npm run auth:generate`):
 *   auth generate --config scripts/auth-cli.ts --output src/server/db/schema/auth.ts
 * It reuses the pure options factory so the generated tables always match the app's plugins.
 * Schema generation needs no database connection; the fallbacks below are never used to serve requests.
 */
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/node-postgres";
import { createAuthOptions } from "../src/server/auth/options";

const db = drizzle(
  process.env.DATABASE_URL ?? "postgres://localhost:5432/geula_dev",
  { casing: "snake_case" },
);

export const auth = betterAuth(
  createAuthOptions({
    db,
    secret:
      process.env.BETTER_AUTH_SECRET ??
      "dev-only-auth-cli-schema-generation-secret",
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
  }),
);
