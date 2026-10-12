import "server-only";
import type { AdminContext } from "@/server/domain/admin";
import type { ServiceResult } from "@/server/domain/effects";
import { env as defaultEnv, type Env } from "@/server/env";
import {
  type BusinessProfile,
  type CheckoutSettings,
  getSetting,
  getSettingOrNull,
  type SaleSettings,
  saveSetting,
} from "@/server/settings";

/**
 * Settings forms (spec §6.10 `/admin/settings/{business,checkout}`, §4.7) and the read-only
 * Providers panel: modes and "configured" flags derived from env, **never** secret values.
 */
export interface ProvidersPanel {
  paymentProviders: string[];
  cardcom: { mode: string; configured: boolean };
  paypal: { mode: string; configured: boolean };
  taxDocuments: { mode: string };
  morning: { mode: string; configured: boolean };
  shipping: { carrier: string };
  dhl: { mode: string; configured: boolean };
  email: { driver: string; configured: boolean };
  storage: { driver: string };
  demo: boolean;
  twoFactorRequired: boolean;
}

export function providersPanel(env: Env = defaultEnv): ProvidersPanel {
  return {
    paymentProviders: [...env.PAYMENT_PROVIDERS],
    cardcom: {
      mode: env.CARDCOM_MODE,
      configured: Boolean(env.CARDCOM_TERMINAL_NUMBER && env.CARDCOM_API_NAME),
    },
    paypal: {
      mode: env.PAYPAL_MODE,
      configured: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
    },
    taxDocuments: { mode: env.TAX_DOCUMENTS_MODE },
    morning: {
      mode: env.MORNING_MODE,
      configured: Boolean(env.MORNING_CLIENT_ID && env.MORNING_CLIENT_SECRET),
    },
    shipping: { carrier: env.SHIPPING_CARRIER },
    dhl: {
      mode: env.DHL_EXPRESS_MODE,
      configured: Boolean(env.DHL_API_KEY && env.DHL_API_SECRET),
    },
    email: {
      driver: env.EMAIL_DRIVER,
      configured: env.EMAIL_DRIVER !== "resend" || Boolean(env.RESEND_API_KEY),
    },
    storage: { driver: env.STORAGE_DRIVER },
    demo: env.DEMO_MODE,
    twoFactorRequired: env.ADMIN_REQUIRE_2FA,
  };
}

export function saveBusinessProfile(
  ctx: AdminContext,
  value: BusinessProfile,
): Promise<ServiceResult<BusinessProfile>> {
  return saveSetting(ctx, "business_profile", value);
}

/** The checkout form: everything but the sale, which keeps its stored value (its own form). */
export async function saveCheckoutSettings(
  ctx: AdminContext,
  value: Omit<CheckoutSettings, "sale">,
): Promise<ServiceResult<CheckoutSettings>> {
  const current = await getSettingOrNull("checkout");
  return saveSetting(ctx, "checkout", { ...value, sale: current?.sale ?? {} });
}

/** The sale form (`src/lib/sale.ts`): only `checkout.sale` changes; single works keep theirs. */
export async function saveSaleSettings(
  ctx: AdminContext,
  sale: Omit<SaleSettings, "perWork">,
): Promise<ServiceResult<CheckoutSettings>> {
  const current = await getSetting("checkout");
  return saveSetting(ctx, "checkout", {
    ...current,
    sale: { ...sale, perWork: current.sale.perWork },
  });
}

/** One work's own percentage during the sale (artwork editor); null = the sale's percentage. */
export async function saveWorkSalePercent(
  ctx: AdminContext,
  artworkId: string,
  percentOff: number | null,
): Promise<ServiceResult<CheckoutSettings>> {
  const current = await getSetting("checkout");
  const perWork = { ...current.sale.perWork };
  if (percentOff === null) delete perWork[artworkId];
  else perWork[artworkId] = percentOff;
  return saveSetting(ctx, "checkout", {
    ...current,
    sale: { ...current.sale, perWork },
  });
}
