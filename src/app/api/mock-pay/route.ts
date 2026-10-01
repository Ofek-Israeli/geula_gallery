import { connection } from "next/server";
import { z } from "zod";
import { LOCALE_VALUES } from "@/lib/locale";
import { absoluteUrl, localePath, paths } from "@/lib/routes";
import { env } from "@/server/env";
import {
  applyMockPageAction,
  mockProviderAllowed,
} from "@/server/payments/providers/mock";

/**
 * `POST /api/mock-pay` (spec §4.2 `mock`): the buttons of the mock hosted page. A plain form POST
 * answered with a 303, like a real provider's page, so the browser does a full navigation to the
 * shop's return URL. Exists only where the mock provider is allowed. Every button also sends the
 * signed webhook (best effort).
 */
const schema = z.object({
  ref: z.string().regex(/^mock_[0-9a-f]{32}$/),
  op: z.enum([
    "pay",
    "approve",
    "review",
    "decline",
    "cancel",
    "pay_no_return",
  ]),
  locale: z.enum(LOCALE_VALUES),
});

export async function POST(request: Request): Promise<Response> {
  await connection();
  if (!mockProviderAllowed(env)) {
    return new Response("Not found", { status: 404 });
  }
  const form = await request.formData();
  const parsed = schema.safeParse(Object.fromEntries(form.entries()));
  if (!parsed.success) return new Response("Bad request", { status: 400 });
  const { ref, op, locale } = parsed.data;
  const result = await applyMockPageAction(ref, op);
  if (!result) return new Response("Not found", { status: 404 });
  const location =
    result.redirectTo ??
    absoluteUrl(
      env.APP_URL,
      `${localePath(locale, paths.mockPay(ref))}?done=1`,
    );
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}
