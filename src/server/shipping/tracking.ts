import "server-only";
import { notImplemented } from "@/server/domain/errors";

/** Tracking poll (spec §5.6): called by the hourly `tracking` job. Body: WS3. */
export async function pollTracking(_opts: {
  limit: number;
  deadline: number;
}): Promise<{ checked: number; updated: number }> {
  return notImplemented("pollTracking", "WS3");
}
