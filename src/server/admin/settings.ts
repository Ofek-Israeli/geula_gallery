import "server-only";
import type { AdminContext } from "@/server/domain/admin";
import type { ServiceResult } from "@/server/domain/effects";
import { env as defaultEnv, type Env } from "@/server/env";
import {
  type BusinessProfile,
  type CheckoutSettings,
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

export function saveCheckoutSettings(
  ctx: AdminContext,
  value: CheckoutSettings,
): Promise<ServiceResult<CheckoutSettings>> {
  return saveSetting(ctx, "checkout", value);
}
