import { checkDatabase } from "@/server/health";

/**
 * Liveness + database check (spec §2.3). Used by the Playwright `webServer` readiness probe and
 * deploy smoke tests. Returns no configuration or version details.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const db = await checkDatabase();
  return Response.json(
    { ok: db },
    {
      status: db ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
