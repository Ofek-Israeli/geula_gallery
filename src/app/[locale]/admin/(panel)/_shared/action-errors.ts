import "server-only";
import { z } from "zod";
import { amountMinorSchema } from "@/lib/validation/common";
import {
  DomainError,
  NotFoundError,
  NotImplementedError,
} from "@/server/domain/errors";
import { ActionFailure } from "@/server/next/actions";

/**
 * Shared helpers for the WS4 admin Server Actions: domain errors → typed `ActionFailure` codes
 * (the forms translate them from their message namespace), and zod pieces for admin units
 * (cm → mm, kg → g, decimal money → minor units, blank → null).
 */
export async function domainErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof NotFoundError) throw new ActionFailure("NOT_FOUND");
    if (error instanceof DomainError) throw new ActionFailure(error.code);
    if (error instanceof NotImplementedError) {
      throw new ActionFailure("NOT_IMPLEMENTED");
    }
    throw error;
  }
}

const blankToNull = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "")
    ? null
    : v;

const decimal = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().replace(",", ".") : v),
  z.coerce.number().finite(),
);

/** Centimetres typed by the admin (one decimal) → integer millimetres (> 0). */
export const cmToMmSchema = decimal
  .pipe(z.number().positive().max(100_000))
  .transform((cm) => Math.round(cm * 10));

export const optionalCmToMmSchema = z.preprocess(
  blankToNull,
  cmToMmSchema.nullable(),
);

/** Kilograms → integer grams (> 0). */
export const optionalKgToGSchema = z.preprocess(
  blankToNull,
  decimal
    .pipe(z.number().positive().max(10_000))
    .transform((kg) => Math.round(kg * 1000))
    .nullable(),
);

export const optionalAmountMinorSchema = z.preprocess(
  blankToNull,
  amountMinorSchema.nullable(),
);

export const optionalIntSchema = (min: number, max: number) =>
  z.preprocess(
    blankToNull,
    z.coerce.number().int().min(min).max(max).nullable(),
  );

export const intSchema = (min: number, max: number, fallback: number) =>
  z.preprocess(
    (v) => blankToNull(v) ?? fallback,
    z.coerce.number().int().min(min).max(max),
  );

export const nullableText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max).nullable().default(null),
  );
