import "server-only";
import { eq } from "drizzle-orm";
import { audit, auditBy } from "@/server/audit";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { settings } from "@/server/db/schema";
import type { SettingsKey } from "@/server/db/schema/enums";
import type { AdminContext } from "@/server/domain/admin";
import { type ServiceResult, withEffects } from "@/server/domain/effects";
import { NotFoundError } from "@/server/domain/errors";
import { parseSettings, type SettingsValue } from "./schemas";

export * from "./schemas";

/**
 * Settings rows (spec §4.7): JSONB values validated by the zod schemas on every read and write.
 * Reads are never cached (fully dynamic rendering, spec §1.1.5).
 */
export async function getSettingOrNull<K extends SettingsKey>(
  key: K,
  db: DbOrTx = defaultDb,
): Promise<SettingsValue<K> | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row ? parseSettings(key, row.value) : null;
}

/** Throws `NotFoundError` when the row is missing (run `npm run db:seed`). */
export async function getSetting<K extends SettingsKey>(
  key: K,
  db: DbOrTx = defaultDb,
): Promise<SettingsValue<K>> {
  const value = await getSettingOrNull(key, db);
  if (value === null) throw new NotFoundError("settings", key);
  return value;
}

/** Validated upsert with an audit row (before/after are redacted by `audit`). */
export async function saveSetting<K extends SettingsKey>(
  ctx: AdminContext,
  key: K,
  value: unknown,
  db: DbOrTx = defaultDb,
): Promise<ServiceResult<SettingsValue<K>>> {
  const parsed = parseSettings(key, value);
  const before = await getSettingOrNull(key, db);
  await db
    .insert(settings)
    .values({ key, value: parsed, updatedBy: ctx.actor })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: parsed, updatedBy: ctx.actor, updatedAt: new Date() },
    });
  await audit(
    {
      ...auditBy(ctx),
      action: "settings.updated",
      entity: "settings",
      entityId: key,
      before,
      after: parsed,
    },
    db,
  );
  return withEffects(parsed, { revalidate: true });
}
