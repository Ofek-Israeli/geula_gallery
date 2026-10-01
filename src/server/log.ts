import "server-only";
import { redact } from "@/server/security/redact";

/**
 * Redacting logger (spec §7 PII). Structured JSON lines; `data` is deep-redacted. Never log raw
 * request bodies, provider payloads or buyer PII.
 */
type Level = "debug" | "info" | "warn" | "error";

function errorFields(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error === undefined ? undefined : { value: String(error) };
}

function emit(
  level: Level,
  msg: string,
  data?: Record<string, unknown>,
  error?: unknown,
) {
  const line = JSON.stringify({
    level,
    msg,
    at: new Date().toISOString(),
    ...(data ? { data: redact(data) } : {}),
    ...(error !== undefined ? { error: errorFields(error) } : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) =>
    emit("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) =>
    emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>, error?: unknown) =>
    emit("warn", msg, data, error),
  error: (msg: string, data?: Record<string, unknown>, error?: unknown) =>
    emit("error", msg, data, error),
};
