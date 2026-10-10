/**
 * `npm run admin:create [-- --db <name>]`
 * `npm run prod:admin`     (the production database, from .env.production.local)
 *
 * Creates the painter's admin account from ADMIN_EMAIL / ADMIN_PASSWORD (read from .env.local).
 * When either is not set, it asks in the terminal: the password twice, without echoing it, so it
 * never lands in a file or the shell history. Idempotent by email, refuses a fourth user, never
 * prints the password (spec §8.4).
 */
import { createInterface } from "node:readline/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/server/db/schema";
import {
  argValue,
  dbNameOf,
  isLocalUrl,
  requireEnv,
  withClient,
  withDatabase,
} from "./lib/db";
import { readSeedEnv } from "./seed/index";
import { createAdminUser, MAX_ADMIN_USERS } from "./seed/users";

const args = process.argv.slice(2);
const base = requireEnv("DATABASE_URL");
const dbArg = argValue(args, "--db");
if (dbArg && !isLocalUrl(base)) {
  console.error("[admin:create] --db is only allowed for local databases.");
  process.exit(1);
}
const url = dbArg ? withDatabase(base, dbArg) : base;

/** A line typed in the terminal, echoed. */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** A line typed in the terminal without echo (raw mode): Enter ends it, Ctrl+C aborts. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          finish();
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function needTerminal(name: string): void {
  if (!process.stdin.isTTY) {
    console.error(
      `[admin:create] ${name} is not set and there is no terminal to type it in.`,
    );
    process.exit(1);
  }
}

let email = process.env.ADMIN_EMAIL?.trim() ?? "";
if (!email) {
  needTerminal("ADMIN_EMAIL");
  email = await ask("Admin email: ");
}
let password = process.env.ADMIN_PASSWORD ?? "";
if (!password) {
  needTerminal("ADMIN_PASSWORD");
  password = await askHidden("Password (at least 12 characters, not shown): ");
  if ((await askHidden("The same password again: ")) !== password) {
    console.error(
      "[admin:create] the two passwords differ; nothing was created.",
    );
    process.exit(1);
  }
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("[admin:create] the admin email is not valid.");
  process.exit(1);
}
if (password.length < 12) {
  console.error(
    "[admin:create] ADMIN_PASSWORD must be at least 12 characters.",
  );
  process.exit(1);
}
const env = readSeedEnv();
if (!env.betterAuthSecret) requireEnv("BETTER_AUTH_SECRET");

try {
  const result = await withClient(url, (client) =>
    createAdminUser(
      drizzle(client, { schema, casing: "snake_case" }),
      { email, password, name: "Painter" },
      env,
    ),
  );
  console.log(
    result === "created"
      ? `[admin:create] created admin ${email} in ${dbNameOf(url)} (the password is not printed)`
      : `[admin:create] admin ${email} already exists in ${dbNameOf(url)}; nothing to do`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[admin:create] failed: ${message} (max ${MAX_ADMIN_USERS} users)`,
  );
  process.exit(1);
}
