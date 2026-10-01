import { connection } from "next/server";
import { applyEffects } from "@/server/next/effects";
import { handlePaymentWebhook } from "@/server/payments/webhook";
import { clientIp } from "@/server/security/ip";

/**
 * `POST /api/payments/[provider]/webhook` (spec §5.2): authenticate first (no DB before the HMAC /
 * token check), record the event until it is processed, finalize, and answer 500 on failure so the
 * provider retries. Thin: the logic lives in `server/payments/webhook.ts`.
 */
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  await connection();
  const rawBody = await request.text();
  const { provider } = await params;
  const out = await handlePaymentWebhook({
    provider,
    headers: request.headers,
    rawBody,
    query: new URL(request.url).searchParams,
    ip: clientIp(request.headers),
  });
  applyEffects(out.effects);
  return Response.json(out.body, { status: out.status, headers: NO_STORE });
}
