import "server-only";

/**
 * Side effects a domain service asks the Next layer to run after it commits (spec §2.2).
 * Services never import `next/*`; `src/server/next/effects.ts#applyEffects` runs these.
 */
export interface Effects {
  /** Outbox jobs were enqueued: process a small batch after the response (`after()`). */
  outbox?: boolean;
  /** Public data changed: `revalidatePath('/', 'layout')`. */
  revalidate?: boolean;
}

/** Every mutating service returns `{ result, effects }`. */
export interface ServiceResult<T> {
  result: T;
  effects: Effects;
}

export const NO_EFFECTS: Effects = Object.freeze({});

export function withEffects<T>(
  result: T,
  effects: Effects = NO_EFFECTS,
): ServiceResult<T> {
  return { result, effects };
}

export function mergeEffects(...all: Effects[]): Effects {
  return {
    outbox: all.some((e) => e.outbox) || undefined,
    revalidate: all.some((e) => e.revalidate) || undefined,
  };
}
