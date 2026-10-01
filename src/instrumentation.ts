/**
 * Runs once per server instance before any request. Importing the env module validates every
 * variable and cross-field rule (spec §4.8), so a misconfigured deployment fails at boot.
 */
export async function register(): Promise<void> {
  await import("@/server/env");
}
