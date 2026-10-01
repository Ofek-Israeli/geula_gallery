/**
 * Fixture replay for provider contract tests (spec §4.1: "tests inject a fixture-replaying
 * fetch"). Fixtures live in `tests/fixtures/<provider>/<scenario>.json` in the format written by
 * `scripts/check-support.ts#writeFixture` (live, redacted) or by hand from the provider's OpenAPI
 * schema (`recordedAt: "synthetic"`).
 *
 * `replayFetch(routes)` answers each request with the first unused route whose method and path
 * match, records what was sent (method, path, headers, parsed body) and fails loudly on anything
 * unexpected, so a test also proves which calls an adapter makes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ReplayRoute {
  method: string;
  /** Exact path (with query) or a pattern tested against the path + query. */
  path: string | RegExp;
  status: number;
  body?: unknown;
  /** Throw this instead of answering (e.g. a timeout). */
  error?: Error;
  /** Raw (non-JSON) response bytes. */
  raw?: Uint8Array;
  contentType?: string;
}

export interface SentRequest {
  method: string;
  url: string;
  path: string;
  headers: Headers;
  bodyText: string;
  body: unknown;
}

export interface FixtureFile {
  provider: string;
  scenario: string;
  recordedAt: string;
  note: string;
  exchanges: {
    request: { method: string; path: string; body: unknown };
    response: { status: number; body: unknown };
  }[];
}

export function loadFixture(provider: string, scenario: string): FixtureFile {
  const file = resolve(
    process.cwd(),
    "tests",
    "fixtures",
    provider,
    `${scenario}.json`,
  );
  return JSON.parse(readFileSync(file, "utf8")) as FixtureFile;
}

/** Fixture exchanges → routes (paths matched exactly, ignoring the query of recorded tokens). */
export function routesFrom(fixture: FixtureFile): ReplayRoute[] {
  return fixture.exchanges.map((x) => ({
    method: x.request.method,
    path: x.request.path.split("?")[0] ?? x.request.path,
    status: x.response.status,
    body: x.response.body,
  }));
}

export function replayFetch(routes: ReplayRoute[]) {
  const pending = [...routes];
  const sent: SentRequest[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const full = `${url.pathname}${url.search}`;
    const bodyText = await request.text();
    let body: unknown = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = bodyText;
    }
    sent.push({
      method: request.method,
      url: request.url,
      path: full,
      headers: request.headers,
      bodyText,
      body,
    });
    const index = pending.findIndex(
      (r) =>
        r.method === request.method &&
        (typeof r.path === "string"
          ? r.path === full || r.path === url.pathname
          : r.path.test(full)),
    );
    if (index < 0) {
      throw new Error(`unexpected request ${request.method} ${full}`);
    }
    const [route] = pending.splice(index, 1);
    if (!route) throw new Error("unreachable");
    if (route.error) throw route.error;
    if (route.raw) {
      return new Response(new Blob([new Uint8Array(route.raw)]), {
        status: route.status,
        headers: { "Content-Type": route.contentType ?? "application/pdf" },
      });
    }
    return new Response(
      route.body === undefined ? null : JSON.stringify(route.body),
      {
        status: route.status,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  return { fetch, sent, pending };
}

/** A fetch that times out like `AbortSignal.timeout` would. */
export function timeoutError(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}
