import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { log } from "@/server/log";

/** `SELECT 1` against the app pool; never throws. */
export async function checkDatabase(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch (error) {
    log.error("health.db_failed", {}, error);
    return false;
  }
}
