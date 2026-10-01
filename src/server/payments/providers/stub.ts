import "server-only";
import { ProviderNotConfiguredError } from "@/server/integrations/http";

/**
 * Shared helper for the M1 adapter stubs (spec §4.1: "M1 creates typed stubs for every adapter …
 * that throw ProviderNotConfiguredError, so both registries compile on every branch"). WS5
 * replaces each stub's network methods; WS2 replaces the mock provider.
 */
export function notConfigured(provider: string, what: string): never {
  throw new ProviderNotConfiguredError(
    provider,
    `${provider}.${what} is not implemented yet (M1 stub)`,
  );
}
