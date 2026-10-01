import "server-only";
import createClient, { type Client, type HeadersOptions } from "openapi-fetch";
import type { z } from "zod";
import { log } from "@/server/log";

/**
 * Typed HTTP for every provider (spec §4.1). `createTypedClient<paths>()` wraps openapi-fetch 0.17.0
 * with a per-request timeout, redacted logging (method, path and status only; never bodies),
 * one automatic retry for idempotent GETs, and typed errors. `expectData()` validates the fields an
 * adapter relies on with zod; an unparseable response counts as "outcome unknown".
 *
 * WS5 owns this file after `contracts-v1`; the error classes are a frozen contract.
 *
 * `recordingFetch()` captures redacted request/response pairs for fixtures (`RECORD_FIXTURES`,
 * the live `check:*` scripts); `parseBodyText()` is the shared tolerant body reader.
 */

export type ProviderName =
  | "cardcom"
  | "paypal"
  | "morning"
  | "dhl"
  | "resend"
  | "blob"
  | "mock";

export abstract class ProviderError extends Error {
  /** True when the provider may or may not have acted (timeouts, garbled responses). */
  abstract readonly outcomeUnknown: boolean;
  constructor(
    public readonly provider: ProviderName | string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/** The request timed out or the connection dropped after sending: the outcome is unknown. */
export class ProviderTimeoutError extends ProviderError {
  readonly outcomeUnknown = true;
  constructor(provider: string, message = "request timed out") {
    super(provider, message);
    this.name = "ProviderTimeoutError";
  }
}

/** The response could not be parsed or lacked a field we rely on: treated as unknown. */
export class ProviderInvalidResponseError extends ProviderError {
  readonly outcomeUnknown = true;
  constructor(provider: string, message: string, status?: number) {
    super(provider, message, status);
    this.name = "ProviderInvalidResponseError";
  }
}

/** A clear refusal (4xx, or a documented non-zero result code). Nothing happened. */
export class ProviderRejectedError extends ProviderError {
  readonly outcomeUnknown = false;
  constructor(
    provider: string,
    message: string,
    status?: number,
    /** Provider error code, e.g. Cardcom `ResponseCode` or PayPal `name`. */
    public readonly code?: string,
  ) {
    super(provider, message, status);
    this.name = "ProviderRejectedError";
  }
}

/** 5xx or a connection failure before the request was sent. Safe to retry later. */
export class ProviderUnavailableError extends ProviderError {
  readonly outcomeUnknown = false;
  constructor(provider: string, message: string, status?: number) {
    super(provider, message, status);
    this.name = "ProviderUnavailableError";
  }
}

/** The adapter has no credentials or is a stub (spec §4.1: M1 stubs throw this). */
export class ProviderNotConfiguredError extends ProviderError {
  readonly outcomeUnknown = false;
  constructor(provider: string, message = "provider is not configured") {
    super(provider, message);
    this.name = "ProviderNotConfiguredError";
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

export type FetchLike = (input: Request) => Promise<Response>;

export interface TypedClientOptions {
  provider: ProviderName;
  baseUrl: string;
  /** Injected in tests (fixture replay); defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  headers?: HeadersOptions;
  timeoutMs?: number;
}

const IDEMPOTENT = new Set(["GET", "HEAD"]);

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * A fetch that adds the timeout, logs, retries idempotent GETs once on a network error or 5xx,
 * and converts transport failures into `ProviderTimeoutError` / `ProviderUnavailableError`.
 */
export function instrumentedFetch(
  provider: ProviderName,
  baseFetch: FetchLike,
  timeoutMs: number,
): FetchLike {
  return async (request: Request) => {
    const method = request.method.toUpperCase();
    const pathname = new URL(request.url).pathname;
    const attempts = IDEMPOTENT.has(method) ? 2 : 1;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      const started = Date.now();
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      try {
        const response = await baseFetch(
          new Request(i === 0 ? request : request.clone(), { signal }),
        );
        log.debug("provider.http", {
          provider,
          method,
          path: pathname,
          status: response.status,
          ms: Date.now() - started,
        });
        if (response.status >= 500 && i + 1 < attempts) continue;
        return response;
      } catch (error) {
        lastError = error;
        log.warn("provider.http_error", {
          provider,
          method,
          path: pathname,
          ms: Date.now() - started,
          error: (error as Error)?.name,
        });
        if (isTimeout(error)) {
          if (i + 1 < attempts) continue;
          throw new ProviderTimeoutError(provider);
        }
        if (i + 1 < attempts) continue;
      }
    }
    // A non-timeout network failure on a mutating request may still have reached the provider.
    if (!IDEMPOTENT.has(method)) {
      throw new ProviderTimeoutError(
        provider,
        `network error: ${(lastError as Error)?.message ?? "unknown"}`,
      );
    }
    throw new ProviderUnavailableError(
      provider,
      `network error: ${(lastError as Error)?.message ?? "unknown"}`,
    );
  };
}

/** `createTypedClient<paths>({ provider, baseUrl, fetch, headers, timeoutMs = 15000 })` (spec §4.1). */
export function createTypedClient<Paths extends {}>(
  opts: TypedClientOptions,
): Client<Paths> {
  const fetchImpl: FetchLike =
    opts.fetch ?? ((request: Request) => globalThis.fetch(request));
  return createClient<Paths>({
    baseUrl: opts.baseUrl,
    headers: opts.headers,
    fetch: instrumentedFetch(
      opts.provider,
      fetchImpl,
      opts.timeoutMs ?? 15_000,
    ),
  });
}

/**
 * Turns an openapi-fetch result into validated data, or throws the matching provider error:
 * 5xx → unavailable, 4xx → rejected, a body that fails `schema` → invalid response (unknown).
 */
export function expectData<S extends z.ZodType>(
  provider: ProviderName,
  result: { data?: unknown; error?: unknown; response: Response },
  schema: S,
): z.infer<S> {
  const { status } = result.response;
  if (status >= 500) {
    throw new ProviderUnavailableError(provider, `HTTP ${status}`, status);
  }
  if (status >= 400) {
    // PayPal `name`, generic `code`, Cardcom `ResponseCode`, Morning `errorCode`.
    const body =
      typeof result.error === "object" && result.error !== null
        ? (result.error as Record<string, unknown>)
        : {};
    const raw = body.name ?? body.code ?? body.ResponseCode ?? body.errorCode;
    const code =
      typeof raw === "string" || typeof raw === "number"
        ? String(raw) || undefined
        : undefined;
    throw new ProviderRejectedError(provider, `HTTP ${status}`, status, code);
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    throw new ProviderInvalidResponseError(
      provider,
      `unexpected response shape: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => i.path.join("."))
        .join(", ")}`,
      status,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------- fixtures (RECORD_FIXTURES)

/** One redacted HTTP exchange, as stored under `tests/fixtures/<provider>/*.json`. */
export interface RecordedExchange {
  request: { method: string; path: string; body: unknown };
  response: { status: number; body: unknown };
}

/** Parses a JSON body; anything else (empty, HTML, binary) is returned as `{ text }` metadata. */
export function parseBodyText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { nonJsonBodyLength: text.length };
  }
}

/**
 * Wraps a fetch so every exchange is appended to `sink` with both bodies passed through `redact`
 * first. Only the path and query are kept (no host), and headers are never recorded, so
 * credentials and tokens cannot leak into fixtures. Bodies are read from clones; the caller's
 * request and response are untouched.
 */
export function recordingFetch(
  base: FetchLike,
  sink: RecordedExchange[],
  redactBody: (body: unknown) => unknown,
): FetchLike {
  return async (request: Request) => {
    const url = new URL(request.url);
    const reqText = await request
      .clone()
      .text()
      .catch(() => "");
    const response = await base(request);
    const resText = await response
      .clone()
      .text()
      .catch(() => "");
    sink.push({
      request: {
        method: request.method.toUpperCase(),
        path: `${url.pathname}${url.search}`,
        body: redactBody(parseBodyText(reqText)),
      },
      response: {
        status: response.status,
        body: redactBody(parseBodyText(resText)),
      },
    });
    return response;
  };
}
