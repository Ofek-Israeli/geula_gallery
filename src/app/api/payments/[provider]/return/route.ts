import { connection } from "next/server";
import { applyEffects } from "@/server/next/effects";
import { handlePaymentReturn } from "@/server/payments/webhook";
import { clientIp } from "@/server/security/ip";

/**
 * `GET /api/payments/[provider]/return?a&r&l&s` (spec §5.2): the buyer's browser coming back from
 * the provider. Verifies the return token, finalizes within an 8 s budget (the `s` hint is never
 * trusted) and 303-redirects to the order page with `&payment=<outcome>`.
 */
export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  await connection();
  const { provider } = await params;
  const out = await handlePaymentReturn({
    provider,
    query: new URL(request.url).searchParams,
    ip: clientIp(request.headers),
  });
  applyEffects(out.effects);
  if (out.status === 303 && out.location) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: out.location,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  return new Response("Too many requests", {
    status: out.status,
    headers: { "Cache-Control": "no-store", "Retry-After": "60" },
  });
}
