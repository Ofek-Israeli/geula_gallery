import { betterAuth } from "better-auth";
import { count, eq, sql } from "drizzle-orm";
import { createAuthOptions } from "@/server/auth/options";
import * as authSchema from "@/server/db/schema/auth";
import type { SeedDb, SeedEnv, SeedModule } from "./types";

/** The painter plus at most 2 others (spec §6.10). */
export const MAX_ADMIN_USERS = 3;

export interface AdminUserInput {
  email: string;
  password: string;
  name: string;
}

export type CreateAdminResult = "created" | "exists";

/**
 * `admin:create` logic (spec §8.4): a script-local Better Auth instance with sign-up enabled calls
 * `auth.api.signUpEmail`. Idempotent by email; refuses a fourth user. Never logs the password.
 */
export async function createAdminUser(
  db: SeedDb,
  input: AdminUserInput,
  env: Pick<SeedEnv, "betterAuthSecret" | "authBaseUrl">,
): Promise<CreateAdminResult> {
  const email = input.email.trim().toLowerCase();
  const existing = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(sql`lower(${authSchema.user.email})`, email))
    .limit(1);
  if (existing.length > 0) return "exists";

  const [row] = await db.select({ n: count() }).from(authSchema.user);
  if ((row?.n ?? 0) >= MAX_ADMIN_USERS) {
    throw new Error(
      `refusing to create a user: ${MAX_ADMIN_USERS} admin users already exist`,
    );
  }
  if (!env.betterAuthSecret) {
    throw new Error("BETTER_AUTH_SECRET is not set");
  }

  const options = createAuthOptions({
    db,
    schema: authSchema,
    secret: env.betterAuthSecret,
    baseURL: env.authBaseUrl,
    allowSignUp: true,
  });
  const auth = betterAuth({
    ...options,
    emailAndPassword: { ...options.emailAndPassword, autoSignIn: false },
    // Scripts never serve HTTP; keep the Better Auth logger quiet about the missing request.
    logger: { disabled: true },
  });

  await auth.api.signUpEmail({
    body: { email, password: input.password, name: input.name },
  });
  await db
    .update(authSchema.user)
    .set({ emailVerified: true })
    .where(eq(authSchema.user.email, email));
  return "created";
}

export const usersSeed: SeedModule = {
  name: "users",
  modes: ["demo"],
  async run({ db, env, log }) {
    const wanted: AdminUserInput[] = [];
    if (env.adminEmail && env.adminPassword) {
      wanted.push({
        email: env.adminEmail,
        password: env.adminPassword,
        name: "Painter",
      });
    } else {
      log(
        "users: ADMIN_EMAIL / ADMIN_PASSWORD not set; painter account skipped (run `npm run admin:create` later)",
      );
    }
    if (env.seedE2eUsers) {
      for (const email of ["e2e-admin@example.test", "e2e-2fa@example.test"]) {
        wanted.push({
          email,
          password: env.e2eAdminPassword,
          name: email.split("@")[0] ?? "e2e",
        });
      }
    }
    for (const user of wanted) {
      const result = await createAdminUser(db, user, env);
      log(`users: ${user.email} ${result}`);
    }
  },
};
