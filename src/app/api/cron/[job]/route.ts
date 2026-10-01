import { connection } from "next/server";
import { env } from "@/server/env";
import { isCronJobName, runCronJob } from "@/server/jobs";
import { safeEqual } from "@/server/security/crypto";

/**
 * `GET /api/cron/<job>` (spec §5.11): Vercel Cron (vercel.json) or `npm run cron -- <job>`.
 * `Authorization: Bearer ${CRON_SECRET}` compared in constant time; 60 s function budget, jobs stop
 * starting work after 50 s. A failed job answers 500 (Vercel records it); the `cron_runs` row has
 * the details.
 */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ job: string }> },
): Promise<Response> {
  await connection();
  const auth = request.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return Response.json(
      { error: "UNAUTHORIZED" },
      { status: 401, headers: NO_STORE },
    );
  }
  const { job } = await params;
  if (!isCronJobName(job)) {
    return Response.json(
      { error: "UNKNOWN_JOB" },
      { status: 404, headers: NO_STORE },
    );
  }
  const result = await runCronJob(job);
  return Response.json(result, {
    status: result.ok ? 200 : 500,
    headers: NO_STORE,
  });
}
