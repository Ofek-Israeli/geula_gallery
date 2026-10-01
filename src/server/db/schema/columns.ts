import "server-only";
import { type SQL, sql } from "drizzle-orm";
import { timestamp } from "drizzle-orm/pg-core";

/** `timestamptz` (spec §2.5: timestamptz everywhere). */
export const tstz = () => timestamp({ withTimezone: true, mode: "date" });

/** `created_at` / `updated_at` on every table (spec §3.1). */
export const timestamps = {
  createdAt: tstz().notNull().defaultNow(),
  updatedAt: tstz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Slug format shared by series and artworks (spec §2.5). */
export const SLUG_REGEX = "^[a-z0-9]+(-[a-z0-9]+)*$";

/** SQL `IN (...)` list of string literals for CHECK constraints. Values are code constants. */
export function sqlInList(values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error(`unsafe literal ${v}`);
  }
  return sql.raw(values.map((v) => `'${v}'`).join(", "));
}
