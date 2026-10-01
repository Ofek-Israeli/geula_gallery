/**
 * `npm run cron` — HTTP client for the cron route (spec §2.2, §5.11). Scripts never import jobs;
 * this calls `GET ${APP_URL}/api/cron/<job>` with `Authorization: Bearer ${CRON_SECRET}`, so
 * `npm run dev` or `npm start` must be running.
 *
 *   npm run cron -- outbox              run one job once
 *   npm run cron -- reconcile outbox    run several, in order
 *   npm run cron -- --watch             every minute, run each job whose vercel.json schedule
 *                                       matches the current UTC minute (local Vercel Cron)
 *   npm run cron -- --watch outbox      run the named job(s) every minute
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { cronMatches, parseCron } from "./lib/cron-schedule";

const JOBS = ["reconcile", "outbox", "tracking", "daily", "purge"] as const;
type Job = (typeof JOBS)[number];

const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("[cron] CRON_SECRET is not set (run `npm run env:init`).");
  process.exit(1);
}

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const named = args.filter((a) => !a.startsWith("-"));
for (const name of named) {
  if (!(JOBS as readonly string[]).includes(name)) {
    console.error(`[cron] unknown job "${name}". Jobs: ${JOBS.join(", ")}`);
    process.exit(1);
  }
}
if (!watch && named.length === 0) {
  console.error(
    `Usage: npm run cron -- <job...> | --watch [job...]\nJobs: ${JOBS.join(", ")}`,
  );
  process.exit(1);
}

function loadSchedules(): Map<Job, ReturnType<typeof parseCron>> {
  const file = path.join(process.cwd(), "vercel.json");
  const config = JSON.parse(readFileSync(file, "utf8")) as {
    crons?: { path: string; schedule: string }[];
  };
  const map = new Map<Job, ReturnType<typeof parseCron>>();
  for (const c of config.crons ?? []) {
    const job = c.path.replace(/^\/api\/cron\//, "") as Job;
    if ((JOBS as readonly string[]).includes(job))
      map.set(job, parseCron(c.schedule));
  }
  return map;
}

async function run(job: Job): Promise<boolean> {
  const started = Date.now();
  try {
    const res = await fetch(`${appUrl}/api/cron/${job}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(90_000),
    });
    const body = await res.text();
    const stamp = new Date().toISOString();
    console.log(
      `[cron] ${stamp} ${job} → ${res.status} in ${Date.now() - started} ms ${body}`,
    );
    return res.ok;
  } catch (error) {
    console.error(
      `[cron] ${job} failed: ${(error as Error).message}. Is the app running at ${appUrl}?`,
    );
    return false;
  }
}

if (!watch) {
  let ok = true;
  for (const job of named as Job[]) ok = (await run(job)) && ok;
  process.exit(ok ? 0 : 1);
}

const schedules = named.length ? null : loadSchedules();
console.log(
  `[cron] watching ${appUrl}: ${named.length ? `${named.join(", ")} every minute` : "vercel.json schedules (UTC)"}. Ctrl+C to stop.`,
);

async function tick(): Promise<void> {
  const now = new Date();
  const due = schedules
    ? [...schedules].filter(([, s]) => cronMatches(s, now)).map(([job]) => job)
    : (named as Job[]);
  for (const job of due) await run(job);
}

let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
  process.exit(0);
});

await tick();
while (!stopped) {
  const msToNextMinute = 60_000 - (Date.now() % 60_000) + 50;
  await new Promise((resolve) => setTimeout(resolve, msToNextMinute));
  await tick();
}
