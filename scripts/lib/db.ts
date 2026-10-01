/**
 * Shared helpers for the database scripts (db-setup, db-migrate, db-reset, seed, admin-create).
 * Scripts read `process.env` directly (the app reads it only through src/server/env.ts) because
 * they must work against databases other than DATABASE_URL (`--db <name>`) and before the app's
 * full configuration exists.
 */
import pg from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `[db] ${name} is not set. Run \`npm run env:init\` (writes .env.local) or export it.`,
    );
    process.exit(1);
  }
  return value;
}

export function isLocalUrl(url: string): boolean {
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

/** Exit unless `url` points at a local Postgres (spec §8.1: refuse non-localhost hosts). */
export function assertLocal(url: string, script: string): void {
  if (!isLocalUrl(url)) {
    console.error(
      `[${script}] refusing to run against non-local host "${new URL(url).hostname}".`,
    );
    process.exit(1);
  }
}

export function assertDbName(name: string): string {
  if (!DB_NAME.test(name)) {
    console.error(
      `[db] invalid database name "${name}" (expected ${DB_NAME.source}).`,
    );
    process.exit(1);
  }
  return name;
}

export function dbNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** Same server and credentials as `url`, different database. */
export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${assertDbName(name)}`;
  return u.toString();
}

/** Value of `--flag <v>` or `--flag=<v>`. */
export function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/** Run `fn` with a dedicated client (not a pool) and always close it. */
export async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: url,
    application_name: "geula-scripts",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function quoteIdent(name: string): string {
  return `"${assertDbName(name)}"`;
}
