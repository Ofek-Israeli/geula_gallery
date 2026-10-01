/**
 * Shared helpers for the opt-in live checks `npm run check:{cardcom,paypal,morning,dhl}`
 * (spec §10.5). Never part of `verify`.
 *
 * - `loadEnv()` imports `@/server/env` lazily so a configuration error is reported by variable
 *   name (never by value) instead of crashing with a stack trace.
 * - `writeFixture()` stores redacted HTTP exchanges under `tests/fixtures/<provider>/<name>.json`
 *   (only with `--record` or `RECORD_FIXTURES=1`). Every body passes through the provider's
 *   redactor first; headers and hosts are never recorded.
 * - `skip()` ends a check cleanly (exit 0) when credentials are missing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RecordedExchange } from "@/server/integrations/http";

export type Env = import("@/server/env").Env;

export const args = process.argv.slice(2);
export const flag = (name: string) => args.includes(`--${name}`);
export const option = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};

export const recording = () =>
  flag("record") || /^(1|true|yes)$/i.test(process.env.RECORD_FIXTURES ?? "");

export function say(check: string, message: string): void {
  console.log(`[${check}] ${message}`);
}

export function skip(check: string, reason: string): never {
  console.log(`[${check}] SKIPPED: ${reason}`);
  process.exit(0);
}

export function fail(check: string, reason: string): never {
  console.error(`[${check}] FAILED: ${reason}`);
  process.exit(1);
}

export async function loadEnv(check: string): Promise<Env> {
  try {
    const mod = await import("@/server/env");
    return mod.env;
  } catch (error) {
    const problems = (error as { problems?: string[] }).problems;
    fail(
      check,
      `invalid environment${problems ? `:\n  ${problems.join("\n  ")}` : ` (${(error as Error).message})`}`,
    );
  }
}

/** Replaces URL query values that carry tokens (`t`, `r`, `k`, `token`) with `REDACTED`. */
export function redactUrlTokens(value: unknown): unknown {
  if (typeof value === "string") {
    if (!/^https?:\/\//.test(value)) return value;
    try {
      const url = new URL(value);
      for (const key of ["t", "r", "k", "token"]) {
        if (url.searchParams.has(key)) url.searchParams.set(key, "REDACTED");
      }
      return url.toString();
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(redactUrlTokens);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redactUrlTokens(v),
      ]),
    );
  }
  return value;
}

export interface FixtureFile {
  provider: string;
  scenario: string;
  recordedAt: string;
  note: string;
  exchanges: RecordedExchange[];
}

export function writeFixture(
  provider: string,
  scenario: string,
  note: string,
  exchanges: RecordedExchange[],
): string {
  const dir = path.join(process.cwd(), "tests", "fixtures", provider);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${scenario}.json`);
  const body: FixtureFile = {
    provider,
    scenario,
    recordedAt: new Date().toISOString().slice(0, 10),
    note,
    exchanges,
  };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return path.relative(process.cwd(), file);
}
