import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Better Auth browser client (spec §6.10). Admin sign-in goes through it, i.e. through
 * `/api/auth/*`, so Better Auth's database rate limits apply. Use only in Client Components.
 * Created lazily so server rendering of client components never needs a base URL.
 */
function create() {
  return createAuthClient({ plugins: [twoFactorClient()] });
}

let client: ReturnType<typeof create> | null = null;

export function getAuthClient(): ReturnType<typeof create> {
  client ??= create();
  return client;
}
