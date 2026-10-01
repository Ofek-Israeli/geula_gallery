import "server-only";
import { and, count, eq, isNull } from "drizzle-orm";
import { LEGAL_TEXTS_APPROVED } from "@/content/legal/versions";
import { type DbOrTx, db as defaultDb } from "@/server/db/client";
import { artworks, sales, user } from "@/server/db/schema";
import { env as defaultEnv, type Env } from "@/server/env";
import { getSettingOrNull } from "@/server/settings";

/**
 * Go-live blockers (spec §1.2 "Live checkout is refused while blockers exist", §6.9, §11.4 #13).
 * `liveBlocked` is what `checkoutProviders(...)` takes for LIVE providers (the M2 approximation
 * was `!business_profile.completed`); the admin dashboard and the daily digest list the codes.
 * Read-only.
 */
export const GOLIVE_BLOCKERS = [
  "DEMO_MODE",
  "PROFILE_INCOMPLETE",
  "LEGAL_NOT_APPROVED",
  "RATES_UNCALIBRATED",
  "INSURANCE_UNCONFIRMED",
  "MOCK_SALES_ON_REAL_WORKS",
  "DEMO_WORKS_PUBLISHED",
  "ADMIN_2FA_MISSING",
  "CARDCOM_NOT_LIVE",
] as const;
export type GoLiveBlocker = (typeof GOLIVE_BLOCKERS)[number];

export interface GoLiveReport {
  ok: boolean;
  blockers: GoLiveBlocker[];
}

export async function goLiveBlockers(
  deps: { db?: DbOrTx; env?: Env; legalApproved?: boolean } = {},
): Promise<GoLiveReport> {
  const db = deps.db ?? defaultDb;
  const e = deps.env ?? defaultEnv;
  const blockers: GoLiveBlocker[] = [];

  if (e.DEMO_MODE) blockers.push("DEMO_MODE");
  const [profile, shipping] = await Promise.all([
    getSettingOrNull("business_profile", db),
    getSettingOrNull("shipping", db),
  ]);
  if (!profile?.completed) blockers.push("PROFILE_INCOMPLETE");
  if (!(deps.legalApproved ?? LEGAL_TEXTS_APPROVED)) {
    blockers.push("LEGAL_NOT_APPROVED");
  }
  if (!shipping?.calibratedAt) blockers.push("RATES_UNCALIBRATED");
  if (
    shipping?.insurance.enabled &&
    shipping.insurance.provider !== "NONE" &&
    !shipping.insurance.coverageConfirmedAt
  ) {
    blockers.push("INSURANCE_UNCONFIRMED");
  }

  const [mockOnReal] = await db
    .select({ n: count() })
    .from(sales)
    .innerJoin(artworks, eq(artworks.id, sales.artworkId))
    .where(
      and(
        eq(sales.isMock, true),
        isNull(sales.voidedAt),
        eq(artworks.isDemo, false),
      ),
    );
  if ((mockOnReal?.n ?? 0) > 0) blockers.push("MOCK_SALES_ON_REAL_WORKS");

  const [demoPublished] = await db
    .select({ n: count() })
    .from(artworks)
    .where(and(eq(artworks.isDemo, true), eq(artworks.isPublished, true)));
  if ((demoPublished?.n ?? 0) > 0) blockers.push("DEMO_WORKS_PUBLISHED");

  const users = await db
    .select({ twoFactorEnabled: user.twoFactorEnabled })
    .from(user);
  if (users.length === 0 || users.some((u) => !u.twoFactorEnabled)) {
    blockers.push("ADMIN_2FA_MISSING");
  }

  if (e.CARDCOM_MODE !== "live" || !e.CARDCOM_API_PASSWORD) {
    blockers.push("CARDCOM_NOT_LIVE");
  }

  return { ok: blockers.length === 0, blockers };
}

/** True while any blocker exists (live providers are refused; spec §5.1 step 3.4). */
export async function liveBlocked(
  deps: { db?: DbOrTx; env?: Env } = {},
): Promise<boolean> {
  return !(await goLiveBlockers(deps)).ok;
}
