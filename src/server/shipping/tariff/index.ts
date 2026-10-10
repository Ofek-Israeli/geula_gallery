import "server-only";
import { jerusalemDateKey } from "@/lib/format";
import { DHL_EXPRESS_IL_2026 } from "./dhl-express-il-2026";
import { ISRAEL_POST_2026 } from "./israel-post-2026";
import type { DhlTariff } from "./types";

export type {
  DhlTariff,
  IsraelPostTariff,
  PerZone,
  PostSizeLimit,
  PostWeightBand,
} from "./types";
export { DHL_EXPRESS_IL_2026, ISRAEL_POST_2026 };

/**
 * Published DHL tariffs, oldest first. A new rate guide is added as a new entry with its
 * `validFrom`; quotes from that day use it (`dhlTariffOn`).
 */
export const DHL_TARIFFS: readonly DhlTariff[] = [DHL_EXPRESS_IL_2026];

/** The tariff in force on `date` (Asia/Jerusalem day); before the first guide, the first one. */
export function dhlTariffOn(date: Date): DhlTariff {
  const day = jerusalemDateKey(date);
  let current = DHL_TARIFFS[0] as DhlTariff;
  for (const t of DHL_TARIFFS) if (t.validFrom <= day) current = t;
  return current;
}
