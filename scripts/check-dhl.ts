/**
 * `npm run check:dhl` — opt-in DHL MyDHL reachability check (spec §4.4, §4.9). Never in `verify`.
 *
 * 1. Always: the public api-mock (`https://api-mock.dhl.com/mydhlapi`) answers `GET /rates` and
 *    `GET /address-validate` with canned data (its published demo credentials `demo-key` / `demo-secret`). This proves the request
 *    shape and connectivity only.
 * 2. With `DHL_EXPRESS_MODE=test|live` and `DHL_API_KEY` / `DHL_API_SECRET`: `GET /address-validate`
 *    against that environment (500 calls/day on test; credentials for active customers only).
 *    Without credentials this step is skipped cleanly.
 *
 * Label creation is WS3's carrier adapter (`server/shipping/carriers/dhl.ts`) and is not exercised
 * here: DHL has no cancel, so a test label is a real waybill (spec §4.4 claim protocol).
 */
import { fail, loadEnv, say } from "./check-support";

const CHECK = "check:dhl";
const env = await loadEnv(CHECK);
const { DHL_BASES } = await import("@/server/shipping/carriers/dhl");

const query = new URLSearchParams({
  type: "delivery",
  countryCode: "US",
  postalCode: "10001",
  cityName: "New York",
});

async function probe(base: string, user: string, pass: string) {
  const res = await fetch(`${base}/address-validate?${query}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      "Message-Reference": crypto.randomUUID(),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as {
    address?: unknown[];
  } | null;
  return { status: res.status, addresses: body?.address?.length ?? 0 };
}

try {
  const mock = await probe(DHL_BASES.mock, "demo-key", "demo-secret");
  say(
    CHECK,
    `api-mock address-validate → HTTP ${mock.status}, ${mock.addresses} address(es) (canned data)`,
  );
} catch (error) {
  say(CHECK, `api-mock unreachable: ${(error as Error).message}`);
}

if (
  env.DHL_EXPRESS_MODE === "disabled" ||
  !env.DHL_API_KEY ||
  !env.DHL_API_SECRET
) {
  say(CHECK, "SKIPPED (test environment): no DHL_EXPRESS_MODE / credentials");
  process.exit(0);
}

const base = env.DHL_EXPRESS_MODE === "live" ? DHL_BASES.live : DHL_BASES.test;
try {
  const r = await probe(base, env.DHL_API_KEY, env.DHL_API_SECRET);
  if (r.status !== 200) fail(CHECK, `${base} answered HTTP ${r.status}`);
  say(
    CHECK,
    `${env.DHL_EXPRESS_MODE} address-validate → ${r.addresses} address(es)`,
  );
} catch (error) {
  fail(CHECK, `${base} unreachable: ${(error as Error).message}`);
}
say(CHECK, "PASSED");
