import "server-only";

/**
 * Domain errors (spec §9.3 frozen contract). Services throw these; the Next layer maps them to
 * responses (`ActionFailure` codes, HTTP status). Messages never contain PII.
 */
export class DomainError extends Error {
  constructor(
    /** Stable machine code, e.g. `ILLEGAL_TRANSITION`, `NOT_FOUND`. */
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** A conditional state UPDATE matched 0 rows (spec §3.6 `transition()`). */
export class IllegalTransitionError extends DomainError {
  constructor(
    public readonly machine: string,
    public readonly entityId: string,
    public readonly allowedFrom: readonly string[],
    public readonly to: string,
  ) {
    super(
      "ILLEGAL_TRANSITION",
      `${machine} ${entityId}: no row in [${allowedFrom.join(", ")}] to move to ${to}`,
      { machine, entityId, allowedFrom: [...allowedFrom], to },
    );
    this.name = "IllegalTransitionError";
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id?: string) {
    super("NOT_FOUND", `${entity}${id ? ` ${id}` : ""} not found`, {
      entity,
      ...(id ? { id } : {}),
    });
    this.name = "NotFoundError";
  }
}

/** A business rule refused the request (e.g. "refused while a payment is in flight"). */
export class ConflictError extends DomainError {
  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
    this.name = "ConflictError";
  }
}

/** Input that passed zod but violates a domain rule (e.g. amount ≠ order total). */
export class ValidationError extends DomainError {
  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
    this.name = "ValidationError";
  }
}

/**
 * A frozen contract whose body a later milestone or workstream implements (spec §9.1 step 12:
 * "typed stubs"). The `owner` names who fills it in.
 */
export class NotImplementedError extends Error {
  constructor(
    public readonly what: string,
    public readonly owner: string,
  ) {
    super(`${what} is not implemented yet (owner: ${owner})`);
    this.name = "NotImplementedError";
  }
}

export function notImplemented(what: string, owner: string): never {
  throw new NotImplementedError(what, owner);
}

/** SQLSTATE of a pg error (also when wrapped by drizzle in `cause`). */
export function pgErrorCode(error: unknown): string | undefined {
  let e: unknown = error;
  for (let depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The constraint name of a pg error (unique / check / FK violations). */
export function pgConstraint(error: unknown): string | undefined {
  let e: unknown = error;
  for (let depth = 0; e && depth < 4; depth++) {
    const c = (e as { constraint?: unknown }).constraint;
    if (typeof c === "string") return c;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_DEADLOCK = "40P01";
export const PG_SERIALIZATION_FAILURE = "40001";

export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) return false;
  return constraint === undefined || pgConstraint(error) === constraint;
}
